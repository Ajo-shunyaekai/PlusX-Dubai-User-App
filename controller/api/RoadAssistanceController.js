import multer from 'multer';
import dotenv from 'dotenv';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, getPaginatedData, updateRecord } from '../../dbUtils.js';
import db from "../../config/db.js";
import { asyncHandler, createNotification, formatDateTimeInQuery, mergeParam, checkCoupon } from '../../utils.js';
dotenv.config();
import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
import { io } from '../../server.js';
import moment from "moment-timezone";

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = path.join(__dirname, 'public', 'uploads', 'order_file');
        cb(null, destinationPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename     = `${uniqueSuffix}-${file.originalname}`;
        cb(null, filename);
    }
});
export const upload = multer({ storage: storage });

export const addRoadAssistance = asyncHandler(async (req, resp) => {
    const { rider_id, user_name, country_code, contact_no, address, latitude, longitude, vehicle_id, address_id, parking_number='', parking_floor ='', service_price= 0, device_name = '', coupon_code='', battery_percent = 1
    } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id      : ["required"], 
        user_name     : ["required"], 
        country_code  : ["required"], 
        contact_no    : ["required"], 
        address       : ["required"], 
        latitude      : ["required"], 
        longitude     : ["required"],
        vehicle_id    : ["required"], 
        address_id    : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    try {
        const currDate = moment().utcOffset(4).format('dddd');
        const currTime = moment().utcOffset(4).format('HH:mm:ss');
        const riderAddress = await queryDB(`
            SELECT 
                landmark,
                (SELECT CONCAT(vehicle_make, ", ", vehicle_model, ", ", vehicle_specification, ", ", emirates, "-", vehicle_code, "-", vehicle_number) FROM riders_vehicles where rider_id =? and vehicle_id = ? ) AS vehicle_data,
                ( SELECT slot_price FROM road_assistance_slot WHERE status = 1 AND slot_date = "${currDate}" AND "${currTime}" BETWEEN start_time AND end_time order by start_time asc limit 1 ) as slot_price,
                (
                    CASE 
                        WHEN ? = 0 THEN 
                            (SELECT rsa_additional_price FROM booking_price LIMIT 1)
                        ELSE NULL 
                    END
                ) AS additional_price
            FROM 
                rider_address
            WHERE 
                rider_id =? and address_id = ? order by id desc
            LIMIT 1 `,
        [ rider_id, vehicle_id, battery_percent, rider_id, address_id ]);

        if(!riderAddress) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });
        if(riderAddress.slot_price < 1) {
            
            const slotContent = await queryDB(`SELECT content FROM response_content WHERE module_name = ? AND response_type = ? Order by id desc LIMIT 1 `, [ `road-assistance-price`, 'error' ]);
            return resp.json({ message : [ slotContent?.content || '' ], status: 0, code: 202, error: true });
        }
        if(riderAddress.vehicle_data == '' || riderAddress.vehicle_data == null) return resp.json({ message : ["Vehicle Id not valid!"], status: 0, code: 422, error: true });
        
        const additional_price = (battery_percent == 0 ) ? parseFloat(riderAddress.additional_price) : 0.0 ;
        const booking_price    = parseFloat( riderAddress.slot_price ) + parseFloat( additional_price );
        const vatAmt           = Math.floor(( booking_price ) * 5) / 100; 
        const bookingPrice     = Math.floor( ( parseFloat(booking_price) + parseFloat(vatAmt) ) * 100) ;

        if(parseFloat(service_price) != bookingPrice && coupon_code == '') { 
            return resp.json({ 
                message      : ['The booking price is invalid.'], 
                status       : 0, 
                code         : 201, 
                error        : true, 
                bookingPrice : parseFloat(booking_price).toFixed(2), 
                vatAmt       : parseFloat(vatAmt).toFixed(2), 
                couponPrice  : parseFloat(0).toFixed(2)
            });
        }
        else if(parseFloat(service_price) != bookingPrice && coupon_code) {
            const servicePrice = parseFloat(service_price);
            const couponData   = await checkCoupon(rider_id, 'Roadside Assistance', coupon_code, booking_price);
            
            if(couponData.status == 0 ){
                return resp.json({ message : [couponData.message], status: 0, code: 422, error: true });

            } else if(servicePrice != couponData.service_price ){
                 
                return resp.json({ 
                    message      : ['The booking price is invalid.'], 
                    status       : 0, 
                    code         : 201, 
                    error        : true, 
                    bookingPrice : parseFloat(booking_price).toFixed(2), 
                    couponPrice  : parseFloat(couponData.dis_price).toFixed(2), 
                    vatAmt       : parseFloat(couponData.vat_amt).toFixed(2),
                });
            }
        }
        const area         = riderAddress.landmark;
        const vehicle_data = riderAddress.vehicle_data;
        
        const insert = await insertRecord('road_assistance', [
            'request_id', 'rider_id', 'name', 'country_code', 'contact_no', 'address_id', 'pickup_address', 'pickup_latitude', 'pickup_longitude', 'parking_number', 'parking_floor', 'vehicle_id', 'price', 'order_status', 'device_name', 'area', 'current_percent', 'vehicle_data', 'booking_price'
        ], [
            'RAO', rider_id, user_name, country_code, contact_no, address_id, address, latitude, longitude, parking_number, parking_floor, vehicle_id, service_price, 'PNR', device_name, area, battery_percent, vehicle_data, booking_price
        ]);

        if(insert.affectedRows === 0) return resp.json({status:0, code:200, message: ['Oops! There is something went wrong! Please Try Again.']});

        const requestId = 'RAO' + String(insert.insertId).padStart(4, '0');
        await updateRecord('road_assistance', { request_id : requestId }, ['id'], [insert.insertId] );

        return resp.json({
            status     : 1, 
            code       : 200, 
            message    : ['We have received your booking and our team will reach out to you soon.'],
            request_id : requestId,
        });
    } catch(err) {
        console.log("Transaction failed:", err);
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }  
});

export const roadAssistanceList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, bookingStatus } = mergeParam(req); 
        
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit           = 10;
    const start           = ( page_no * limit ) - limit;
    
    let statusCondition = (bookingStatus == 'CM' ) ? `order_status IN (?, ?, ?)` : `order_status IN (?)`;
    let statusParams    = (bookingStatus == 'C' ) ? ['C'] : ['RO', 'PU', 'CC'];
    statusParams        = (bookingStatus == 'S' ) ? ['CNF'] : statusParams;
    const orderBy       = 'ORDER BY id DESC';
    
    const totalQuery  = `SELECT COUNT(*) AS total FROM road_assistance WHERE rider_id = ? AND ${statusCondition}`;
    const [totalRows] = await db.execute(totalQuery, [rider_id, ...statusParams]);
    const total       = totalRows[0].total;
    const totalPage   = Math.max(Math.ceil(total / limit), 1);

    const bookingsQuery = `
        SELECT 
            request_id, ROUND(road_assistance.price/100, 2) AS price, name, country_code, contact_no, order_status, ${formatDateTimeInQuery(['created_at'])}, pickup_address
        FROM 
            road_assistance 
        WHERE 
            rider_id = ? AND ${statusCondition} ${orderBy} 
        LIMIT 
            ${parseInt(start)}, ${parseInt(limit)}
    `;
    const [bookingList] = await db.execute(bookingsQuery, [rider_id, ...statusParams]);
    
    let inProcessBookingList = [];
    if(bookingStatus === 'S'){
        const inProcessQuery = `
            SELECT 
                request_id, ROUND(road_assistance.price/100, 2) AS price, name, country_code, contact_no, order_status, ${formatDateTimeInQuery(['created_at'])}, pickup_address
            FROM 
                road_assistance 
            WHERE 
                rider_id = ? AND order_status NOT IN (?, ?, ?, ?, ?, ?) ${orderBy} 
            LIMIT 
                ${parseInt(start)}, ${parseInt(limit)}
        `;
        const inProcessParams = ['CNF', 'C', 'PU', 'RO', 'PNR', 'CC'];
        const [inProcessrow]  = await db.execute(inProcessQuery, [rider_id, ...inProcessParams]);
        inProcessBookingList  = inProcessrow;
    }
    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Road Assistance List fetch successfully!"],
        data       : bookingList,
        total_page : totalPage,
        total      : total,
        inProcessBookingList,
        base_url    : `${process.env.DIR_UPLOADS}road-assistance/`,
        noResultMsg : 'There are no recent bookings. Please schedule your booking now.'
    });
});

export const roadAssistanceDetail = asyncHandler(async (req, resp) => {
    const { rider_id, order_id } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], order_id: ["required"]});
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const [[bookingWithNull]] = await db.execute(`
        SELECT 
            request_id, name, country_code, contact_no, pickup_address, order_status, ROUND(road_assistance.price/100, 2) AS price, ${formatDateTimeInQuery(['created_at'])},
            (select concat(rsa_name, ",", country_code, " ", mobile) from rsa where rsa.rsa_id = road_assistance.rsa_id) as rsa_data, vehicle_id, vehicle_data, current_percent
        FROM 
            road_assistance 
        WHERE 
            rider_id = ? AND request_id = ? 
        LIMIT 1
    `, [rider_id, order_id]);
    if(!bookingWithNull) return resp.json({ status: 0, code: 404, message: ["There are no booking available for the provided booking ID."] });
    
    const roadAssistance = Object.fromEntries(
        Object.entries(bookingWithNull).map(([key, value]) => [
            key,
            value === null ? "" : value
        ])
    );
    if(roadAssistance.vehicle_data == '' || roadAssistance.vehicle_data == null) {
        const vehicledata = await queryDB(`
            SELECT                 
                vehicle_make, vehicle_model, vehicle_specification, emirates, vehicle_code, vehicle_number
            FROM 
                riders_vehicles
            WHERE 
                rider_id = ? and vehicle_id = ? 
            LIMIT 1 `,
        [ rider_id, roadAssistance.vehicle_id ]);
        if(vehicledata) {
            roadAssistance.vehicle_data = vehicledata.vehicle_make + ", " + vehicledata.vehicle_model+ ", "+ vehicledata.vehicle_specification+ ", "+ vehicledata.emirates+ "-" + vehicledata.vehicle_code + "-"+ vehicledata.vehicle_number ;
        }
    }
    const [history] = await db.execute(`
        SELECT 
            order_status, rsa_id, ${formatDateTimeInQuery(['created_at'])}, 
            (select rsa.rsa_name from rsa where rsa.rsa_id = order_history.rsa_id) as rsa_name
        FROM order_history 
        WHERE order_id = ?
        ORDER BY id ASC
    `,[order_id]);
    const newHistory =  await makeBookingHistory(history);
    return resp.json({
        message       : ["Road Assistance Details fetched successfully!"],
        order_data    : roadAssistance,
        order_history : newHistory,
        status        : 1,
        code          : 200,
    });
});

/* Invoice */
export const roadAssistanceInvoiceList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, orderStatus } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    let whereField = ['rider_id'];
    let whereValue = [rider_id];

    if(orderStatus){
        whereField.push('payment_status');
        whereValue.push(orderStatus);
    }
    const result = await getPaginatedData({
        tableName : 'road_assistance_invoice',
        columns   : `invoice_id, amount, payment_status, invoice_date, currency,
            (select concat(name, ",", country_code, "-", contact_no) from road_assistance as rs where rs.rider_id = road_assistance_invoice.rider_id limit 1) AS riderDetails,
            (select types_of_issue from road_assistance as rs where rs.rider_id = road_assistance_invoice.rider_id limit 1) as types_of_issue
        `,
        sortColumn : 'id',
        sortOrder  : 'DESC',
        page_no,
        limit     : 10,
        whereField,
        whereValue
    });
    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Road Assistance Invoice List fetch successfully!"],
        data       : result.data,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${process.env.DIR_UPLOADS}road-side-invoice/`,
    });
});

export const roadAssistanceInvoiceDetail = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const data = await queryDB(`
        SELECT 
            rsi.request_id as booking_id, invoice_id, invoice_date, r.name as user_name, r.country_code, r.contact_no, r.pickup_address as address,
            price_details
        FROM 
            road_assistance_invoice AS rsi
        LEFT JOIN
            road_assistance AS r ON r.request_id = rsi.request_id
        WHERE 
            rsi.request_id = ? AND rsi.rider_id = ?
    `, [ booking_id, rider_id ]);

    if(!data) return resp.json({ status: 0, code: 404, message: ["There are no invoices available for the provided booking ID."] });

    data.booking_price = data.price_details.amount ;   
    data.discount      = data.price_details.discount_prcnt ;   

    data.kw_consume      = data.price_details.kw_consume ; 
    data.dewa_unit_price = data.price_details.dewa_unit_price ; 
    data.cpo_unit_price  = data.price_details.cpo_unit_price ; 

    data.kw_dewa_amt    = data.price_details.kw_dewa_amt ; 
    data.kw_cpo_amt     = data.price_details.kw_cpo_amt ; 
    data.delivry_charge = data.price_details.delivry_charge ; 

    data.vat_amount   = data.price_details.vat_amount ; 
    data.discount_amt = data.price_details.discount_amt ; 
    data.price        = Math.round(data.price_details.total_price) ; 
    
    data.vat_percetange = '5%';

    data.price_details = {};
    return resp.json({
        message        : ["Road Assistance Invoice Details fetch successfully!"],
        data           : data,
        vat_percetange : '5%',
        status         : 1,
        code           : 200,
    });
});

export const userFeedbacRSABooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, description ='', rating } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"],
        rating     : ["required"],  
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT 
            rsa_id, name 
        FROM 
            road_assistance
        WHERE 
            request_id = ? AND rider_id = ? AND order_status IN ('PU', 'RO') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const feedbackCount = await queryDB(
        'SELECT COUNT(*) as count FROM road_assistance_feedback WHERE rider_id = ? AND request_id = ?',[rider_id, booking_id]
    );
    if (feedbackCount.count === 0) {
       
        const insert = await insertRecord('road_assistance_feedback', [
            'request_id', 'rider_id', 'rsa_id', 'rating', 'description'
        ],[
            booking_id, rider_id, checkOrder.rsa_id, rating, description
        ]);
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });
        
        const href    = `road_assistance/${booking_id}`;
        // const title   = 'Roadside Assistance Feedback!';
        // const message = `Feedback Received - Booking ID: ${booking_id}.`;
        const title   = `Feedback Received- ${booking_id}`;
        const message = `You've received feedback from a customer`;
        await createNotification(title, message, 'Roadside Assistance', 'Admin', 'Rider', rider_id, '', href);

        const adminHtml = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>You have received feedback from a customer via the PlusX app.</p>
                Customer Name : ${checkOrder.name}<br>
                Booking ID    : ${booking_id}<br>
                <p>Rating   : ${rating}</p> 
                <p>Feedback : ${description}</p>
                <p>Please review the feedback and take any necessary actions.</p>
                <p>Best regards,<br/>PlusX Electric Team</p>
            </body>
        </html>`;
        emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Customer Feedback Received - Booking ID: ${booking_id}`, adminHtml);
        io.emit('notification-list', {msCount : 1});
        return resp.json({ message: ['Feedback added successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Feedback already submitted!'], status: 0, code: 200 });
    }
});

const makeBookingHistory = async (history) => {
    
    const bookingStatus =  [
        { "order_status" : "CNF", "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "A",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "ER",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "RL",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "CS",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "CC",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
    ];
    const servicehistory = [];
    for (const item of bookingStatus) {

        const matched = history.find( h => h.order_status === item.order_status );
        if (matched) {
            item.created_at = matched.created_at;
            item.rsa_id     = matched.rsa_id;
            item.rsa_name   = matched.rsa_name;
            item.status     = 1;
        }
        servicehistory.push(item);
    }
    return servicehistory; 
}