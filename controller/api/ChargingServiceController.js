import moment from "moment-timezone";
import dotenv from 'dotenv';
import 'moment-duration-format';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import db from "../../config/db.js";
import { createNotification, mergeParam, pushNotification, formatDateTimeInQuery, asyncHandler, formatDateInQuery, checkCoupon } from "../../utils.js";
dotenv.config();

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
import { io } from '../../server.js';
import { valetChargerInvoice } from '../InvoiceController.js';

export const getChargingServiceDateList = asyncHandler(async (req, resp) => {

    try {
        let dubaiDate       = moment.tz("Asia/Dubai").format('YYYY-MM-DD');
        const oneMonthLater = moment.tz("Asia/Dubai").add(1, 'month').format('YYYY-MM-DD');

        const [slotDates] = await db.execute(`
            SELECT ${formatDateInQuery([('slot_date')])}
            FROM pick_drop_slot
            WHERE status = ? AND slot_date BETWEEN ? AND ?
            GROUP BY slot_date
            ORDER BY slot_date ASC `, [1, dubaiDate, oneMonthLater]
        );
        const dates = [];
        for (const date of slotDates) {

            const currDate = moment().utcOffset(4).format('YYYY-MM-DD');
            const currTime = moment().utcOffset(4).format('HH:mm:ss');

            let whereQ = (date.slot_date == currDate) ? ` AND TIME(pcs.start_time) >= "${currTime}"` : "";
            const bookingSlot = await queryDB(`
                SELECT 
                    COUNT(*) AS available_slot_count
                FROM (
                    SELECT 
                        pcs.id, pcs.booking_limit, ( SELECT COUNT(id) FROM charging_service AS cs 
                        WHERE DATE(cs.slot_date_time) = pcs.slot_date AND TIME(cs.slot_date_time) = pcs.start_time AND cs.order_status NOT IN ("C") ) AS slot_booking_count
                    FROM 
                        pick_drop_slot pcs
                    WHERE 
                        pcs.status = ? AND pcs.slot_date = ? ${whereQ}
                    HAVING 
                        pcs.booking_limit > slot_booking_count
                ) AS available_slots `, [ 1, date.slot_date ]
            );
            if (bookingSlot.available_slot_count) {
                dates.push({ slot_date : date.slot_date})
            }
        }
        return resp.json({ 
            message : "Slot Date List fetch successfully!",  
            data    : dates, 
            status  : 1, 
            code    : 200, 
        });
    } catch(err) {

        tryCatchErrorHandler(req.originalUrl, err, resp );
    }
});

export const getChargingServiceSlotList = asyncHandler(async (req, resp) => {
    const { slot_date, rescheduled_booking} = mergeParam(req);
    if(!slot_date) return resp.json({status:0, code:422, message: ['slot date is required']});
 
    const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
    let query       = `SELECT slot_id, ${formatDateInQuery([('slot_date')])}, start_time, end_time, booking_limit`;
    
    if(fSlotDate >=  moment().format('YYYY-MM-DD')){
        query += `, (SELECT COUNT(id) FROM charging_service AS cs WHERE DATE(cs.slot_date_time) = '${slot_date}' AND TIME(slot_date_time) = pick_drop_slot.start_time AND order_status NOT IN ("C") ) AS slot_booking_count`;
    }
    const currMoment = moment().utcOffset(4);
    const today      = currMoment.format("YYYY-MM-DD");

    if ( ( rescheduled_booking == 1 || rescheduled_booking == "1" ) && slot_date === today ) { 
        const afterSixHoursTime = currMoment.clone().add(6, 'hours').format('HH:mm:ss');
        query += ` FROM pick_drop_slot WHERE status = ? AND slot_date = ? AND start_time > '${afterSixHoursTime}' HAVING booking_limit > slot_booking_count ORDER BY start_time ASC`;  // , "PNR" "WC", 
    } else {
        const currDate = moment().utcOffset(4).format('YYYY-MM-DD');
        const currTime = moment().utcOffset(4).format('HH:mm:ss');
        let whereQ = "" ;
        if(fSlotDate == currDate){
            whereQ = ` AND TIME(start_time) >= "${currTime}"`
        }
        query += ` FROM pick_drop_slot WHERE status = ? AND slot_date = ? ${whereQ} HAVING booking_limit > slot_booking_count ORDER BY start_time ASC`;
    }
    const [slot] = await db.execute(query, [1, fSlotDate]);
 
    return resp.json({ 
        message : "Slot List fetch successfully!",  data: slot, status: 1, code: 200,
        alert2  : "The slots for your selected date are fully booked. Please choose another date to book our EV Pick Up & Drop Off for your EV."
    });
});

export const requestService = asyncHandler(async (req, resp) => {
    
    const { rider_id, name, country_code, contact_no, pickup_address, pickup_latitude, pickup_longitude, parking_number='', parking_floor='', vehicle_id, slot_date_time, slot_id, price = 0, order_status = 'PNR', device_name= '', coupon_code='', address_id } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id         : ["required"],
        name             : ["required"],
        country_code     : ["required"],
        contact_no       : ["required"],
        slot_id          : ["required"],
        pickup_address   : ["required"],
        pickup_latitude  : ["required"],
        pickup_longitude : ["required"],
        vehicle_id       : ["required"],
        slot_date_time   : ["required"],
        address_id       : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    try {
        const riderAddress = await queryDB(`
            SELECT 
                landmark, 
                ( SELECT CONCAT( vehicle_make, ', ', vehicle_model, ', ', vehicle_specification, ', ', emirates, '-', 
                    vehicle_code, '-', vehicle_number) FROM riders_vehicles WHERE  vehicle_id = ? ) AS vehicle_data,
                ( SELECT pick_drop_price FROM booking_price LIMIT 1) as booking_price
            FROM 
                rider_address
            WHERE 
                rider_id = ? and address_id = ? order by id desc
            LIMIT 1 `,
        [ vehicle_id, rider_id, address_id ]);

        if(!riderAddress) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });
        if(riderAddress.vehicle_data == '') return resp.json({ message : ["Vehicle Id not valid!"], status: 0, code: 422, error: true });
    
        const vatAmt       = Math.floor(( parseFloat(riderAddress.booking_price) ) * 5) / 100; 
        const bookingPrice = Math.floor( ( parseFloat(riderAddress.booking_price) + vatAmt ) * 100) ;

        if(parseFloat(price) != bookingPrice && coupon_code == '') { 
            return resp.json({ 
                message      : ['The booking price is invalid.'], 
                status       : 0,
                code         : 201,
                error        : true,
                bookingPrice : parseFloat(riderAddress.booking_price).toFixed(2), 
                vatAmt       : parseFloat(vatAmt).toFixed(2), 
                couponPrice  : parseFloat(0).toFixed(2)
            });
        }
        else if(parseFloat(price) != bookingPrice && coupon_code) {
            const servicePrice = parseFloat(price) ;
            
            const couponData   = await checkCoupon(rider_id, 'Valet Charging', coupon_code);
          
            if(couponData.status == 0 ){
                return resp.json({ message : [couponData.message], status: 0, code: 422, error: true });

            } else if(servicePrice != couponData.service_price ){
                return resp.json({ message : ['Booking price is not valid!'], status: 0, code: 422, error: true, bookingPrice : couponData.service_price });
            }
        }  
        const area = riderAddress.landmark;

        const fSlotDateTime = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss');
        const currDateTime  = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});
        
        const fSlotDate    = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD');
        const slot_time    = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('HH:mm:ss');
        const slotDateTime = moment(slot_date_time).format('YYYY-MM-DD HH:mm:ss');
        // 1. Lock all bookings for this slot
        const [lockedRows] = await db.execute(
            `SELECT id
            FROM charging_service
            WHERE slot_date_time = ? AND order_status NOT IN ("C")
            FOR UPDATE`,
            [ slotDateTime ]
        ); //, 'PNR' "WC", 
        const bookingCount = lockedRows.length;

        // 2. Get slot limit 
        const [slotLimitRows] = await db.execute( `
            SELECT booking_limit
            FROM pick_drop_slot
            WHERE slot_date = ? AND start_time = ? LIMIT 1 
            FOR UPDATE`,
            [fSlotDate, slot_time]
        );
        if (slotLimitRows.length === 0) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        }
        const bookingLimit = slotLimitRows[0].booking_limit;

        // 3.  Double-check limit AFTER locking
        if (bookingCount >= bookingLimit) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        }
        const insert = await insertRecord('charging_service', [
            'request_id', 'vehicle_data', 'rider_id', 'name', 'country_code', 'contact_no', 'vehicle_id', 'slot', 'slot_date_time', 'pickup_address', 'parking_number', 'parking_floor', 
            'price', 'order_status', 'pickup_latitude', 'pickup_longitude', 'device_name', 'area', 'address_id', 'booking_price'
        ], [
            'CS', riderAddress.vehicle_data, rider_id, name, country_code, contact_no, vehicle_id, slot_id, slotDateTime, pickup_address, parking_number, parking_floor, price, order_status, pickup_latitude, pickup_longitude, device_name, area, address_id, riderAddress.booking_price
        ]);

        if(insert.affectedRows === 0) return resp.json({status:0, code:200, message : ["Oops! Something went wrong. Please try again."]}); 

        const requestId = 'CS' + String( insert.insertId ).padStart(4, '0');
        await updateRecord('charging_service', { request_id : requestId }, ['id'], [insert.insertId] );

        return resp.json({
            message    : [ 'We have received your booking. Our team will get in touch with you soon!' ],
            status     : 1,
            service_id : requestId,
            code       : 200,
        });
    } catch(err) {
       
        console.error("Transaction failed:", err);
        tryCatchErrorHandler(req.originalUrl, err, resp );
    } finally {
        // if (conn) conn.release();
    }
});

export const listServices = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, bookingStatus } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit = 10;
    const start = (page_no[0] * limit) - limit;

    let statusCondition = (bookingStatus == 'CM' ) ? `order_status IN (?, ?, ?)` : `order_status IN (?)`; 
    let statusParams    = (bookingStatus == 'C' ) ? ['C'] : ['CC', 'WC', 'DO'];
    statusParams        = (bookingStatus == 'S' ) ? ['CNF'] : statusParams;
    
    const orderBy     = 'ORDER BY slot_date_time ASC';
    const totalQuery  = `SELECT COUNT(*) AS total FROM charging_service WHERE rider_id = ? AND ${statusCondition}`;
    const [totalRows] = await db.execute(totalQuery, [rider_id, ...statusParams]);
    const total       = totalRows[0].total;
    const totalPage   = Math.max(Math.ceil(total / limit), 1);
    
    const formatCols    = ['created_at'];
    const servicesQuery = `
        SELECT 
            request_id, name, country_code, contact_no, slot, ROUND(charging_service.price / 100, 2) AS price, pickup_address, order_status,DATE_FORMAT(slot_date_time, '%Y-%m-%d %H:%i:%s') AS slot_date_time ,
            ${formatDateTimeInQuery(formatCols)}, rescheduled_booking
        FROM charging_service 
        WHERE rider_id = ? AND ${statusCondition} ${orderBy} 
        LIMIT ${parseInt(start)}, ${parseInt(limit)}
    `;
    const [serviceList] = await db.execute(servicesQuery, [rider_id, ...statusParams]);

    let inProcessBookingList = [];
    if(bookingStatus ==='S'){
        const inProcessQuery = `
            SELECT 
                request_id, name, country_code, contact_no, slot, ROUND(charging_service.price / 100, 2) AS price, pickup_address, order_status, DATE_FORMAT(slot_date_time, '%Y-%m-%d %H:%i:%s') AS slot_date_time,
                ${formatDateTimeInQuery(formatCols)}, rescheduled_booking 
            FROM 
                charging_service 
            WHERE 
                rider_id = ? AND order_status NOT IN ('CNF', 'C', 'WC', 'PNR', 'DO', 'CC') 
            ${orderBy} 
            LIMIT 
                ${parseInt(start)}, ${parseInt(limit)} 
        `;
        const [inProcessRow] = await db.execute(inProcessQuery, [rider_id]);
        inProcessBookingList=inProcessRow;
    }
    return resp.json({
        message    : ["Charging Service List fetch successfully!"],
        data       : serviceList,
        total_page : totalPage,
        inProcessBookingList,
        total,
        status : 1,
        code   : 200,
        noResultMsg : 'There are no recent bookings. Please schedule your booking now.'
    });
});

export const getServiceOrderDetail = asyncHandler(async (req, resp) => {
    const {rider_id, service_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], service_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const formatCols = ['created_at', 'updated_at'];
    
    const bookingWithNull = await queryDB(`
        SELECT 
            charging_service.*, ROUND(charging_service.price / 100, 2) AS price,
            ${formatDateTimeInQuery(formatCols)} 
        FROM 
            charging_service 
        WHERE 
            request_id = ? 
        LIMIT 1
    `, [service_id]);
    if(!bookingWithNull) return resp.json({ status: 0, code: 404, message: ["There are no booking available for the provided booking ID."] });
    const order = Object.fromEntries(
        Object.entries(bookingWithNull).map(([key, value]) => [
            key,
            value === null ? "" : value
        ])
    );
    if(order){
        order.invoice_url = '';
        order.slot = 'Schedule';
    }
    order.slot_date_time = moment(order.slot_date_time ).format('YYYY-MM-DD HH:mm:ss');
    const [history] = await db.execute(`
        SELECT 
            order_status, rsa_id, ${formatDateTimeInQuery(['created_at'])},  
            (select rsa.rsa_name from rsa where rsa.rsa_id = charging_service_history.rsa_id) as rsa_name        
        FROM charging_service_history 
        WHERE service_id = ? 
        Order by id ASC`, [service_id]
    );
    const order_status = history.filter(item => item.order_status === 'CNF');
    if(order_status.length > 1) {

        const matchingIndexes = history.map((item, index) => item.order_status === 'CNF' ? index : -1).filter(index => index !== -1);

        const lastValue                 = matchingIndexes[matchingIndexes.length - 1];
        history[lastValue].order_status = 'RPD'
    }
    const newHistory =  await makeBookingHistory(history);
    return resp.json({
        message       : ["Service Order Details fetched successfully!"],
        order_data    : order,
        order_history : newHistory,
        status        : 1,
        code          : 200,
    });
});

/* Invoice */
export const getInvoiceDetail = asyncHandler(async (req, resp) => {
    const {rider_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const invoice = await queryDB(`
        SELECT 
            invoice_id, cs.request_id as booking_id, invoice_date, cs.pickup_address as address, cs.name as user_name, cs.country_code, cs.contact_no,
            price_details
        FROM 
            charging_service_invoice AS csi
        LEFT JOIN
            charging_service AS cs ON cs.request_id = csi.request_id
        WHERE 
            csi.request_id = ? AND csi.rider_id = ? 
    `, [ booking_id, rider_id ]);
    if(!invoice) return resp.json({ status: 0, code: 404, message: ["There are no invoices available for the provided booking ID."] });
    invoice.booking_price = invoice.price_details.amount ;   
    invoice.discount      = invoice.price_details.discount_prcnt ;   

    invoice.kw_consume      = invoice.price_details.kw_consume ; 
    invoice.dewa_unit_price = invoice.price_details.dewa_unit_price ; 
    invoice.cpo_unit_price  = invoice.price_details.cpo_unit_price ; 

    invoice.kw_dewa_amt    = invoice.price_details.kw_dewa_amt ; 
    invoice.kw_cpo_amt     = invoice.price_details.kw_cpo_amt ; 
    invoice.delivry_charge = invoice.price_details.delivry_charge ; 

    invoice.vat_amount   = invoice.price_details.vat_amount ; 
    invoice.discount_amt = invoice.price_details.discount_amt ; 
    invoice.price        = Math.round(invoice.price_details.total_price) ; 
    
    invoice.vat_percetange = '5%';

    invoice.price_details = {};
    return resp.json({
        message        : ["Pick & Drop Invoice Details fetch successfully!"],
        data           : invoice,
        vat_percetange : '5%',
        status         : 1,
        code           : 200,
    });
});

/* User Booking Cancel */
export const cancelValetBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, reason='' } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], booking_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const checkOrder = await queryDB(`
        SELECT 
            cs.name, cs.vehicle_data, cs.rsa_id, DATE_FORMAT(slot_date_time, '%Y-%m-%d %H:%i:%s') AS slot_date_time,
            cs.country_code, cs.contact_no, rd.rider_email, rd.rider_name, rd.fcm_token, cs.pickup_address,
            rsa.email as rsa_email, rsa.fcm_token as rsa_fcm_token, rsa.rsa_name
        FROM 
            charging_service AS cs
        LEFT JOIN  
            riders as rd on rd.rider_id = cs.rider_id
        LEFT JOIN 
            rsa ON rsa.rsa_id = cs.rsa_id 
        WHERE 
            cs.request_id = ? AND cs.rider_id = ? AND order_status IN ('CNF', 'A') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    var slotDateTime = moment(`${checkOrder.slot_date_time}`).format('YYYY-MM-DD HH:mm:ss');
    let dubaiTime    = new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" });
    dubaiTime        = moment(dubaiTime).add(1, 'hours').format('YYYY-MM-DD HH:mm:ss');

    if (slotDateTime <= dubaiTime) {
        return resp.json({
            status  : 0,
            code    : 422,
            message : ['Please note : Cancellations aren not allowed within 2 hours of the scheduled time.']
        });
    }
    const insert = await db.execute(
        'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, cancel_by, cancel_reason) VALUES (?, ?, "C", ?, "User", ?)',
        [booking_id, rider_id, checkOrder.rsa_id, reason]
    );
    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await updateRecord('charging_service', {order_status: 'C'}, ['request_id'], [booking_id]);
    await valetChargerInvoice(rider_id, booking_id);
    const href    = `charging_service/${booking_id}`;
    const title   = 'EV Pick Up & Drop Off Booking!';
    const message = `Booking Cancelled : ${booking_id}`;
    await createNotification(title, message, 'Charging Service', 'Admin', 'Rider', rider_id, '', href);

    const html = `<html>
        <body>
            <h4>Dear ${checkOrder.rider_name},</h4>
            <p>We would like to inform you that your booking for the EV Pickup and Drop-Off charging service has been successfully cancelled. Please find the details of your cancelled booking below:</p>
            <p>Booking ID    : ${booking_id}</p>
            <p>Date and Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')} </p>
            <p>Thank you for using PlusX Electric. We look forward to serving you again soon.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(checkOrder.rider_email, `PlusX Electric App - Booking Cancellation`, html);

    const adminHtml = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>This is to inform you that a user has cancelled their booking for the EV Pickup and Drop-Off Service. Please find the booking details below:</p>
            <p>Booking Details : </p>
            <p>Customer Name       : ${checkOrder.name}</p>
            <p>Contact No.         : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
            <p>Booking ID          : ${booking_id}</p>
            <p>Service Date & Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</P> 
            <p>Vehicle Details     : ${checkOrder.vehicle_data}</p>
            <p>Thank you for your attention to this update.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `EV Pickup & Drop-Off Service Booking Cancellation ( Booking ID : ${booking_id} ) `, adminHtml);
    
    if( checkOrder.rsa_id) {
        
        const rsaHtml = `<html>
            <body>
                <h4>Dear ${checkOrder.rsa_name},</h4>
                <p>This is to inform you that a user has cancelled their booking for the EV Pickup and Drop-Off Service. Please find the booking details below:</p>
                <p>Booking Details:  </p>
                <p>Customer Name       : ${checkOrder.name}</p>
                <p>Contact No.         : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                <p>Booking ID          : ${booking_id}</p>
                <p>Service Date & Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</P> 
                <p>Address             : ${checkOrder.pickup_address}</p>
                <p>Vehicle Details     : ${checkOrder.vehicle_data}</p>
                <p>Thank you for your attention to this update.</p>
                <p>Best regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`; //pickup_address
        emailQueue.addEmail(checkOrder.rsa_email, `EV Pickup & Drop-Off Service Booking Cancellation (Booking ID:${booking_id} )`, rsaHtml);
        await db.execute(`DELETE FROM charging_service_assign WHERE rider_id=? AND order_id = ?`, [rider_id, booking_id]);
        pushNotification(checkOrder.rsa_fcm_token, title, message, 'RSAFCM', href);   
    }
        
    
    io.emit('notification-list', {msCount : 1});
    return resp.json({ message: ['Booking has been cancelled successfully!'], status: 1, code: 200 });
});

export const userFeedbackValetBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, description ='', rating } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"],
        rating     : ["required"],  
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT 
            name, rsa_id
        FROM 
            charging_service
        WHERE 
            request_id = ? AND rider_id = ? AND order_status IN ('DO', 'WC') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const feedbackCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_feedback WHERE rider_id = ? AND booking_id = ?',[rider_id, booking_id]
    );
    if (feedbackCount.count === 0) {
       
        const insert = await insertRecord('charging_service_feedback', [
            'booking_id', 'rider_id', 'rsa_id', 'rating', 'description'
        ],[
            booking_id, rider_id, checkOrder.rsa_id, rating, description
        ]);
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });
        
        const href    = `charging_service/${booking_id}`;
        // const title1   = 'EV Pick Up & Drop Off Feedback!';
        // const message1 = `Feedback Received - Booking ID: ${booking_id}.`;
        
        const title   = `Feedback Received- ${booking_id}`;
        const message = `You've received feedback from a customer`;
        await createNotification(title, message, 'Charging Service', 'Admin', 'Rider', rider_id, '', href);

        const adminHtml = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>You have received feedback from a customer via the PlusX app.</p>
                <p>Customer Name : ${checkOrder.name}</p>
                <p>Booking ID    : ${booking_id}</p>
                <p>Rating        : ${rating}</p>
                <p>Feedback      : ${description}</p>
                <p>Please review the feedback and take any necessary actions.</p>
                <p>Best regards,<br/>PlusX Electric Team</p>
            </body>
        </html>`;
        emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `Customer Feedback Received - Booking ID: ${booking_id}`, adminHtml);
        io.emit('notification-list', {msCount : 1});
        return resp.json({ message: ['Feedback added successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Feedback already submitted!'], status: 0, code: 200 });
    }
});

export const rescheduleService = asyncHandler(async (req, resp) => {
    
    const { rider_id, booking_id, slot_date_time, slot_id, device_name = '', } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id       : ["required"],
        booking_id     : ["required"],
        slot_id        : ["required"],
        slot_date_time : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    try {
        const fSlotDateTime = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss');
        const currDateTime  = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});
        
        const fSlotDate    = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD');
        const slot_time    = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('HH:mm:ss');
        // 1. Lock all bookings for this slot
        const [lockedRows] = await db.execute(
            `SELECT
                id
            FROM 
                charging_service
            WHERE
                slot_date_time = ? AND order_status NOT IN ("C")
            FOR UPDATE`,
            [ fSlotDateTime ]
        ); //, 'PNR' "WC", 
        const bookingCount = lockedRows.length;

        // 2. Get slot limit 
        const [slotLimitRows] = await db.execute( `
            SELECT
                booking_limit
            FROM 
                pick_drop_slot
            WHERE
                slot_date = ? AND start_time = ? LIMIT 1 
            FOR UPDATE`,
            [fSlotDate, slot_time]
        );
        if (slotLimitRows.length === 0) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        } 
        const bookingLimit = slotLimitRows[0].booking_limit;

        // 3.  Double-check limit AFTER locking
        if (bookingCount >= bookingLimit) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        }
        const checkOrder = await queryDB(`
            SELECT
                cs.name, cs.country_code, cs.contact_no, cs.pickup_address, cs.pickup_latitude, cs.pickup_longitude,
                cs.rescheduled_booking, cs.slot_date_time, rd.fcm_token, rd.rider_email, cs.vehicle_data, cs.rsa_id,
                rsa.email as rsa_email, rsa.rsa_name as rsa_name, rsa.fcm_token as rsa_fcm_token
            FROM 
                charging_service as cs
            LEFT JOIN
                riders AS rd ON rd.rider_id = cs.rider_id
                LEFT JOIN
                rsa on cs.rsa_id=rsa.rsa_id
            WHERE 
                cs.request_id = ? AND cs.rider_id = ?
            LIMIT 1 `, 
        [ booking_id, rider_id ]);
        
        if (!checkOrder) {
            return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
        }
        if (checkOrder.rescheduled_booking) {
            return resp.json({ message: [`This booking has already been rescheduled.`], status: 0, code: 404 });
        }
        const oldSlotDateTime = moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss');
        let prevDay = oldSlotDateTime.subtract(3, 'hours').format('YYYY-MM-DD HH:mm:ss');

        if (currDateTime > prevDay) {
            return resp.json({
                message : ["Apologies, rescheduling is only allowed up to 3 hours before the scheduled service time."],
                status  : 0,
                code    : 405,
                error   : true
            })
        }
        const updtFields = {
            order_status        : 'CNF',
            slot                : slot_id,
            slot_date_time      : fSlotDateTime,
            device_name         : device_name,
            rescheduled_booking : 1
        }
        await updateRecord('charging_service', updtFields, ['request_id', 'rider_id'], [booking_id, rider_id]);
        await updateRecord('charging_service_assign', { slot_date_time : fSlotDateTime }, ['order_id', 'rider_id'], [booking_id, rider_id]);

        const insert = await insertRecord('charging_service_history', ['service_id', 'rider_id', 'order_status'], [booking_id, rider_id, 'CNF']); 
        
        if (insert.affectedRows == 0) return resp.json({ status: 0, code: 200, message: ["Oops! Something went wrong. Please try again."] });
        
        const href    = 'charging_service/' + booking_id;
        const heading = 'EV Pick Up & Drop Off Booking!';
        const desc    = `Rescheduled Booking Confirmed! ${booking_id}`;
        createNotification(heading, desc, 'Charging Service', 'Rider', 'Admin', '', rider_id, href);
        createNotification(heading, desc, 'Charging Service', 'Admin', 'Rider', rider_id, '', href);
        pushNotification(checkOrder.fcm_token, heading, desc, 'RDRFCM', href);
        
        const htmlUser = `<html>
            <body>
                <h4>Dear  ${checkOrder.name},</h4>
                <p>We're writing to confirm that your booking for the EV Pickup & Drop-off Service has been successfully rescheduled. Please find the updated details below:</p>
                
                <p>Booking ID: ${booking_id}</p>
                <p>Rescheduled Date & Time : ${moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</p>
                <p>Thank you for choosing PlusX Electric. If you have any questions or need further assistance, feel free to contact us. </p>                  
                <p>Best regards,<br/>PlusX Electric Team</p>
            </body>
        </html>`;
        emailQueue.addEmail(checkOrder.rider_email, `Booking Rescheduled Successfully - ${booking_id}`, htmlUser);
        // const formattedDateTime = moment().utcOffset('+04:00').format('DD MMM YYYY hh:mm A');

        const htmlAdmin = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>This is to inform you that a user has rescheduled their EV Pickup and Drop-off Charging Service booking. Please find the updated booking details below:</p>
                <p>User Name : ${checkOrder.name}</p>
                <p>User Contact: ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                <p>Booking ID  : ${booking_id}</p> 
                <p>New Scheduled Date & Time : ${moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</p>
                <p> Location        : ${checkOrder.pickup_address}</p> 
                <p> Vechile Details : ${checkOrder.vehicle_data}</p>
                <a href="https://www.google.com/maps?q=${checkOrder.pickup_latitude},${checkOrder.pickup_longitude}">Address Link</a><br>
                <p>Best regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
    
        emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Pickup & Drop-off Booking Rescheduled (Booking ID : ${booking_id})`, htmlAdmin);
        
        
        if(checkOrder.rsa_id ) {
            pushNotification(checkOrder.rsa_fcm_token, heading, desc, 'RSAFCM', href);
            const htmlDriver = `<html>
                <body>
                    <h4>Dear  ${checkOrder.rsa_name},</h4>
                    <p>This is to inform you that a user has rescheduled their EV Pickup and Drop-off Charging Service booking. Please find the updated booking details below:</p>
                    <p>User Name : ${checkOrder.name}</p>
                    <p>User Contact: ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                    <p>Booking ID  : ${booking_id}</p> 
                    <p>New Scheduled Date & Time : ${moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</p>
                    <p> Location        : ${checkOrder.pickup_address}</p> 
                    <p> Vechile Details : ${checkOrder.vehicle_data}</p>
                    <a href="https://www.google.com/maps?q=${checkOrder.pickup_latitude},${checkOrder.pickup_longitude}">Address Link</a><br>
                    
                    <p>Best regards,<br/>PlusX Electric Team</p>
                </body>
            </html>`;
            emailQueue.addEmail(checkOrder.rsa_email, `Booking Rescheduled Successfully - ${booking_id}`, htmlDriver);
        }
        let respMsg = "Booking request received! Your booking has been successfully rescheduled. Our team will arrive at the updated time.";
        
        io.emit('notification-list', {msCount : 1});
        return resp.json({
            message    : [ respMsg ],
            status     : 1,
            code       : 200,
        });
    } catch(err) {
        // await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        tryCatchErrorHandler(req.originalUrl, err, resp );
    } finally {
        // if (conn) conn.release();
    }
});

const makeBookingHistory = async (history) => {
    
    const bookingStatus =  [
        { "order_status" : "CNF", "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "RPD", "rsa_id" :  null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "C",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "A",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "ER",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "VP",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "RS",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
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
        if (matched?.order_status === 'C') {
            break;
        }
    }
    let updatedList = servicehistory.filter( item => !(item.order_status === 'C' && item.status === 0) );
    updatedList     = updatedList.filter( item => !(item.order_status === 'RPD' && item.status === 0) );
    return updatedList; 
}