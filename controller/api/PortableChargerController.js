
import moment from "moment-timezone";
import dotenv from 'dotenv';
import 'moment-duration-format';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { queryDB, getPaginatedData, insertRecord, updateRecord } from '../../dbUtils.js';
import db from "../../config/db.js";
import { asyncHandler, createNotification, formatDateInQuery, formatDateTimeInQuery, mergeParam, pushNotification, checkCoupon } from "../../utils.js";
dotenv.config();
import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
import { io } from '../../server.js';
import { createportableChargerInvoice } from '../InvoiceController.js';

export const chargerList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const result = await getPaginatedData({
        tableName  : 'portable_charger',
        columns    : 'charger_id, charger_name, charger_price, charger_feature, image, charger_type',
        sortColumn : 'id',
        sortOrder  : 'ASC',
        page_no,
        limit      : 10,
        whereField : ['status'],
        whereValue : ['1']
    });

    const [slotData] = await db.execute(`SELECT slot_id, start_time, end_time, booking_limit FROM portable_charger_slot WHERE status = ?`, [1]);

    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Portable Charger List fetch successfully!"],
        data       : result.data,
        slot_data  : slotData,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${process.env.DIR_UPLOADS}portable-charger/`,
    });
});

export const getPcSlotDateList = asyncHandler(async (req, resp) => {
    const { rider_id } = mergeParam(req);
    try {
        // Portable POD temporarily unavailable
        // const [contentRows] = await db.execute(`
        //     SELECT content, additional_content as contact_no
        //     FROM response_content
        //     WHERE module_name = ? AND response_type = ? AND status = 1
        //     ORDER BY id ASC
        // `, [ 'portable-charger', 'service-unavailable' ]);

        // if (contentRows.length > 0) {
        //     const contactRow = contentRows.find(row => row.contact_no);
        //     return resp.json({
        //         status        : 0,
        //         code          : 201,
        //         message       : contentRows.map(row => row.content),
        //         teamContactNo : contactRow?.contact_no || '',
        //     });
        // }

        if( rider_id == 'ER0654' ) {
            return resp.json({ message : "Slot Date List fetch successfully!", data: [], status: 1, code: 200});
        }
        let dubaiDate       = moment.tz("Asia/Dubai").format('YYYY-MM-DD');
        const oneMonthLater = moment.tz("Asia/Dubai").add(1, 'month').format('YYYY-MM-DD');
        
        const [slotDates] = await db.execute(`
            SELECT ${formatDateInQuery([('slot_date')])}
            FROM portable_charger_slot
            WHERE status = ? AND slot_date BETWEEN ? AND ?
            GROUP BY slot_date
            ORDER BY slot_date ASC `, [1, dubaiDate, oneMonthLater]
        );
        const dates = [];
        for (const date of slotDates) {

            const currDate = moment().utcOffset(4).format('YYYY-MM-DD');
            const currTime = moment().utcOffset(4).format('HH:mm:ss');

            let whereQ = (date.slot_date == currDate) ? ` AND TIME(pcs.start_time) >= "${currTime}"` : '';
            
            const bookingSlot = await queryDB(`
                SELECT 
                    COUNT(*) AS available_slot_count
                FROM (
                    SELECT 
                        pcs.id, pcs.booking_limit, ( SELECT COUNT(id) FROM portable_charger_booking AS pod 
                        WHERE pod.slot_time = pcs.start_time AND pod.slot_date = pcs.slot_date AND pod.status NOT IN ('C') ) AS slot_booking_count
                    FROM 
                        portable_charger_slot pcs
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

export const getPcSlotList = asyncHandler(async (req, resp) => {
    const { slot_date, rider_id } = mergeParam(req);
    if(!slot_date) return resp.json({status:0, code:422, message: ['slot date is required']});
    
    const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
    
    let query = `SELECT slot_id, ${formatDateInQuery([('slot_date')])}, start_time, end_time, booking_limit`;
    
    if(fSlotDate >=  moment().format('YYYY-MM-DD')){
        query += `, (SELECT COUNT(id) FROM portable_charger_booking AS pod WHERE pod.slot_time = portable_charger_slot.start_time AND pod.slot_date = '${slot_date}' AND status NOT IN ("C")) AS slot_booking_count`;
    } 
    const currDate = moment().utcOffset(4).format('YYYY-MM-DD');
    const currTime = moment().utcOffset(4).format('HH:mm:ss');
    let whereQ = "" ;
    if(fSlotDate == currDate){
        whereQ = ` AND TIME(start_time) >= "${currTime}"`
    }
    query += ` FROM portable_charger_slot WHERE status = ? AND slot_date = ? ${whereQ} HAVING 
            booking_limit > slot_booking_count ORDER BY start_time ASC`;
    const [slot] = await db.execute(query, [1, fSlotDate]);
    
    return resp.json({ 
        message    : "Slot List fetch successfully!",  
        data       : slot, 
        is_booking : 0, 
        status     : 1, 
        code       : 200, 
        alert2     : "The slots for the selected date are fully booked. Please select another date to book the POD for your EV.",
        alert         : "",
        booking_price : 1
    });
});

export const chargerBooking = asyncHandler(async (req, resp) => {
console.log("chargerBooking", req.body, req.params);
    let { rider_id, user_name, country_code, contact_no, address, latitude, longitude, parking_number= '',
        parking_floor='', vehicle_id, slot_date, slot_time, slot_id, service_name, service_type, service_feature, service_price= 0, address_id, device_name ='', coupon_code='', battery_percent = 1
    } = mergeParam(req);
    service_name = service_name || 'Mobile & Portable EV Charging Service';

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id        : ["required"],
        user_name       : ["required"],
        country_code    : ["required"],
        contact_no      : ["required"],
        address         : ["required"],
        latitude        : ["required"],
        longitude       : ["required"],
        vehicle_id      : ["required"],
        slot_date       : ["required"],
        slot_time       : ["required"],
        slot_id         : ["required"],
        service_name    : ["required"],
        service_type    : ["required"],
        service_feature : ["required"],
        address_id      : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    try {
        const riderAddress = await queryDB(`
            SELECT 
                landmark, (select address_alert from portable_charger_booking where rider_id =? and address = ? order by id desc LIMIT 1) as address_alert,
                (SELECT CONCAT(vehicle_make, ", ", vehicle_model, ", ", vehicle_specification, ", ", emirates, "-", vehicle_code, "-", vehicle_number) FROM riders_vehicles where rider_id =? and vehicle_id = ? ) AS vehicle_data,
                ( SELECT portable_price FROM booking_price LIMIT 1) as booking_price,
                (
                    CASE 
                        WHEN ? = 0 THEN 
                            (SELECT pod_additional_price FROM booking_price LIMIT 1)
                        ELSE NULL 
                    END
                ) AS additional_price
            FROM 
                rider_address
            WHERE 
                rider_id =? and address_id = ? order by id desc
            LIMIT 1 `,
        [ rider_id, address, rider_id, vehicle_id, battery_percent, rider_id, address_id ]);
        
        if(!riderAddress) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });
        if(riderAddress.vehicle_data == '') return resp.json({ message : ["Vehicle Id not valid!"], status: 0, code: 422, error: true });
        
        const additional_price = ( battery_percent == 0 ) ? parseFloat(riderAddress.additional_price || 0) : 0.0 ;
        const booking_price    = parseFloat( riderAddress.booking_price ) + parseFloat( additional_price );
        const vatAmt           = Math.floor(( booking_price ) * 5) / 100; 
        const bookingPrice     = Math.floor( ( booking_price + vatAmt ) * 100) ;

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
            const servicePrice = parseFloat(service_price) ;
            const couponData   = await checkCoupon(rider_id, 'POD-On Demand Service', coupon_code);

            if(couponData.status == 0 ){
                return resp.json({ message : [couponData.message], status: 0, code: 422, error: true });

            } else if(servicePrice != couponData.service_price ){
                return resp.json({ 
                    message      : ['The booking price is invalid.'], 
                    status       : 0, 
                    code         : 201, 
                    error        : true, 
                    bookingPrice : parseFloat(couponData.service_price ).toFixed(2), 
                    couponPrice  : parseFloat(couponData.dis_price).toFixed(2),
                    vatAmt       : parseFloat(couponData.vat_amt).toFixed(2),
                });
            }
        }
        const addressAlert = riderAddress.address_alert || '';
        const area         = riderAddress.landmark;
        const vehicle_data = riderAddress.vehicle_data;

        const fSlotDateTime = moment(slot_date + ' ' + slot_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss')
        const currDateTime  = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});

        const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const currDate  = moment().format('YYYY-MM-DD');

        // 1. Lock all bookings for this slot
        const [lockedRows] = await db.execute(
            `SELECT id
            FROM portable_charger_booking
            WHERE slot_time = ? AND slot_date = ? AND status NOT IN ('C')
            FOR UPDATE`,
            [slot_time, fSlotDate]  //'PU', 'RO'
        ); 
        const bookingCount = lockedRows.length;

        // 2. Get slot limit , current_count 
        const [slotLimitRows] = await db.execute( `
            SELECT booking_limit
            FROM portable_charger_slot
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
        if (service_type.toLowerCase() === "get monthly subscription") {
            const [subsCountRows] = await db.execute(`SELECT COUNT(*) AS count FROM portable_charger_subscription WHERE rider_id = ? AND (total_booking >= 10 OR expiry_date < ?) `,
                [rider_id, currDate]
            );
            const subsCount = subsCountRows[0].count;
            if (subsCount > 0) {
                return resp.json({ message: ["Subscription limit exceeded or expired!"], status: 0, code: 422, error: true });
            }
        }
        const insert = await insertRecord('portable_charger_booking', [
            'booking_id', 'rider_id', 'vehicle_id', 'service_name', 'service_price', 'service_type', 'service_feature', 'user_name', 'country_code', 'contact_no', 'slot', 'slot_date', 'slot_time', 'address', 'latitude', 'longitude', 'status', 'address_alert', 'parking_number', 'parking_floor', 'address_id', 'device_name', 'area', 'vehicle_data', 'current_percent', 'booking_price'
        ], [
            'PCB', rider_id, vehicle_id, service_name, service_price, service_type, service_feature, user_name, country_code, contact_no, slot_id, fSlotDate, slot_time, address, latitude, longitude, 'PNR', addressAlert, parking_number, parking_floor, address_id, device_name, area, vehicle_data, battery_percent, booking_price
        ]); 
        if(insert.affectedRows == 0) {
           return resp.json({status:0, code:200, message: ["Oops! Something went wrong. Please try again."]});
        }
        const booking_id = 'PCB' + String( insert.insertId ).padStart(4, '0');
        
        await updateRecord('portable_charger_booking', { booking_id : booking_id }, ['id'], [insert.insertId] );
        return resp.json({
            status        : 1,
            code          : 200,
            booking_id    : booking_id,
            service_price : service_price,
            message       : ["Booking Request Received!."]
        });

    } catch(err) {
        console.log("Transaction failed:", err);
        tryCatchErrorHandler(req.originalUrl, err, resp);

    } finally {

    }
});

export const chargerBookingList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, bookingStatus } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id      : ["required"], 
        page_no       : ["required"],
        bookingStatus : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit  = 10;
    const start  = ( page_no * limit ) - limit;

    let statusCondition = (bookingStatus == 'CM' ) ? `status IN (?, ?, ?)` : `status IN (?)`;
    let statusParams    = (bookingStatus == 'C' ) ? ['C'] : ['RO', 'PU', 'CC'];
    statusParams        = (bookingStatus == 'S' ) ? ['CNF'] : statusParams;

    const orderBy    = 'ORDER BY slot_date ASC, slot_time ASC';  //ORDER BY id ASC
    const totalQuery = `SELECT COUNT(*) AS total FROM portable_charger_booking WHERE rider_id = ? AND ${statusCondition}`;
    
    const [totalRows] = await db.execute(totalQuery, [rider_id, ...statusParams]);
    const total       = totalRows[0].total;
    const totalPage   = Math.max(Math.ceil(total / limit), 1);

    const bookingsQuery = `
        SELECT
            rescheduled_booking, booking_id, service_name, user_name, country_code, contact_no, service_type,
            ROUND(portable_charger_booking.service_price/100, 2) AS service_price, slot_time, status, 
            ${formatDateTimeInQuery(['created_at'])}, ${formatDateInQuery(['slot_date'])}
        FROM 
            portable_charger_booking 
        WHERE rider_id = ? AND ${statusCondition}
        ${orderBy} 
        LIMIT ${parseInt(start)}, ${parseInt(limit)}
    `;
    const [bookingList] = await db.execute(bookingsQuery, [rider_id, ...statusParams]);
    
    let inProcessBookingList = [];
    
    if(bookingStatus === 'S' ) {
        
        const inProcessQuery = `
            SELECT
                rescheduled_booking, booking_id, service_name, user_name, country_code, contact_no, status,
                ROUND(portable_charger_booking.service_price/100, 2) AS service_price, service_type, slot_time,
                ${formatDateTimeInQuery(['created_at'])}, ${formatDateInQuery(['slot_date'])}
            FROM portable_charger_booking 
            WHERE rider_id = ? AND status NOT IN (?, ?, ?, ?, ?, ?) 
            ${orderBy} 
            LIMIT ${parseInt(start)}, ${parseInt(limit)}
        `;
        const inProcessParams = ['CNF', 'C', 'PU', 'RO', 'PNR', 'CC'];
        const [inProcessrow]  = await db.execute(inProcessQuery, [rider_id, ...inProcessParams]);
        inProcessBookingList  = inProcessrow;
    }
    return resp.json({
        message    : ["Portable Charger Booking List fetched successfully!"],
        data       : bookingList,
        total_page : totalPage,
        inProcessBookingList,
        status     : 1,
        code       : 200,
        base_url    : `${process.env.DIR_UPLOADS}portable-charger/`,
        noResultMsg : 'There are no recent bookings. Please schedule your booking now.'
    });
});

export const chargerBookingDetail = asyncHandler(async (req, resp) => {
    const {rider_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], 
        booking_id: ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    const bookingWithNull = await queryDB(`
        SELECT 
            booking_id, rescheduled_booking, rider_id, rsa_id, charger_id, vehicle_id, vehicle_data, service_name, service_type, service_feature, status, user_name, country_code, contact_no, slot, slot_date, slot_time, address, pod_id, parking_number, parking_floor, payment_intent_id, address_id, area, device_name, ROUND(portable_charger_booking.service_price / 100, 2) AS service_price, 
            ${formatDateTimeInQuery(['created_at', 'updated_at'])}, ${formatDateInQuery(['slot_date'])},
            current_percent 
        FROM 
            portable_charger_booking 
        WHERE 
            rider_id = ? AND booking_id = ? 
        LIMIT 1`, 
    [rider_id, booking_id]);
    if(!bookingWithNull) return resp.json({ status: 0, code: 404, message: ["There are no booking available for the provided booking ID."] });
    const booking = Object.fromEntries(
        Object.entries(bookingWithNull).map(([key, value]) => [
            key,
            value === null ? "" : value
        ])
    );
    if(booking.vehicle_data == '' || booking.vehicle_data == null) {
        const vehicledata = await queryDB(`
            SELECT                 
                vehicle_make, vehicle_model, vehicle_specification, emirates, vehicle_code, vehicle_number
            FROM 
                riders_vehicles
            WHERE 
                rider_id = ? and vehicle_id = ? 
            LIMIT 1 `,
        [ rider_id, booking.vehicle_id ]);
        if(vehicledata) {
            booking.vehicle_data = vehicledata.vehicle_make + ", " + vehicledata.vehicle_model+ ", "+ vehicledata.vehicle_specification+ ", "+ vehicledata.emirates+ "-" + vehicledata.vehicle_code + "-"+ vehicledata.vehicle_number ;
        }
    }
    const [history] = await db.execute(`
        SELECT 
            order_status, rsa_id, ${formatDateTimeInQuery(['created_at'])},
            (select rsa.rsa_name from rsa where rsa.rsa_id = portable_charger_history.rsa_id) as rsa_name
        FROM 
            portable_charger_history 
        WHERE 
            booking_id = ? order by id asc`, 
        [booking_id]
    );
    const order_status = history.filter(item => item.order_status === 'CNF');
    if(order_status.length > 1) {

        const matchingIndexes = history.map((item, index) => item.order_status === 'CNF' ? index : -1).filter(index => index !== -1);

        const lastValue                 = matchingIndexes[matchingIndexes.length - 1];
        history[lastValue].order_status = 'RS'
    }
    const newHistory =  await makeBookingHistory(history);
    return resp.json({
        message         : ["POD Booking Details Service fetched successfully!"],
        data            : booking,
        service_history : newHistory,
        status          : 1,
        code            : 200,
    });
});

export const getPcSubscriptionList = asyncHandler(async (req, resp) => {
    const { rider_id } = mergeParam(req);
    if(!rider_id) return resp.json({status: 0, code: 200, error: true, message: ["Rider Id is required"]});

    const data = await queryDB(`
        SELECT subscription_id, amount, expiry_date, booking_limit, total_booking, payment_date 
        FROM portable_charger_subscriptions WHERE rider_id = ? ORDER BY id DESC
    `, [rider_id]);

    if(data?.amount){
        data.amount /= 100; 
    }
    const sPrice = (data && data.expiry_date > moment().format("YYYY-MM-DD") && data.total_booking >= 10) ? 75 : 750;

    return resp.json({
        message: [ "Subscription Details fetch successfully!" ],
        data: data,
        status: 1,
        subscription_price: sPrice,
        code: 200,
        subscription_img: `${req.protocol}://${req.get('host')}/public/pod-no-subscription.jpeg`,
    });
});

/* Invoice */
export const podInvoiceDetails = asyncHandler(async (req, resp) => {
    const {rider_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const data = await queryDB(`
        SELECT 
            pcb.booking_id, invoice_id, invoice_date, pcb.address,
            pcb.user_name, pcb.country_code, pcb.contact_no, pci.price_details
        FROM 
            portable_charger_invoice AS pci 
        LEFT JOIN
            portable_charger_booking AS pcb ON pcb.booking_id = pci.request_id
        WHERE 
            pci.request_id = ? AND pci.rider_id = ?
    `, [ booking_id, rider_id ]);

    if(!data) return resp.json({ status: 0, code: 404, message: ["There are no invoices available for the provided booking ID."] });

    data.booking_price = data.price_details.amount;
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
        message        : ["POD Invoice Details fetch successfully!"],
        data           : data,
        vat_percetange : '5%',
        status         : 1,
        code           : 200,
    });
});

/* User Cancel Booking */
export const userCancelPCBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, reason='' } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], booking_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const checkOrder = await queryDB(`
        SELECT  
            rsa.rsa_name,rsa.email as rsa_email, pcb.rsa_id, pcb.address, pcb.slot_time, pcb.user_name, DATE_FORMAT(pcb.slot_date, '%Y-%m-%d') AS slot_date, pcb.country_code, 
            pcb.contact_no, riders.rider_email, riders.rider_name, riders.fcm_token, rsa.fcm_token as rsa_fcm_token, pcb.vehicle_data
        FROM  
            portable_charger_booking pcb
        LEFT JOIN  
            riders on riders.rider_id=pcb.rider_id 
        LEFT JOIN 
            rsa ON rsa.rsa_id = pcb.rsa_id 
        WHERE 
            pcb.booking_id =? AND pcb.rider_id = ? AND pcb.status IN ('CNF', 'A') 
    `, [booking_id, rider_id]);
 
    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    let slotDateTime = moment(`${checkOrder.slot_date} ${checkOrder.slot_time}`).format('YYYY-MM-DD HH:mm:ss');
    let dubaiTime    = moment.tz("Asia/Dubai").format('YYYY-MM-DD HH:mm:ss');
    
    // let cancellationDeadline = moment(slotDateTime).subtract(1, 'hours').format('YYYY-MM-DD HH:mm:ss');
    let cancellationDeadline = moment(slotDateTime).subtract(2, 'hours').format('YYYY-MM-DD HH:mm:ss');

    if (dubaiTime > cancellationDeadline) {
        return resp.json({
            status  : 0,
            code    : 422,
            // message: ['Please note: Cancellations aren`t allowed within 1 hours of the scheduled time.']
            message: ['Please note: Cancellations aren`t allowed within 2 hours of the scheduled time.']
        });
    }
    const insert = await db.execute(
        'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, cancel_by, cancel_reason) VALUES (?, ?, "C", ?, "User", ?)',
        [booking_id, rider_id, checkOrder.rsa_id, reason]
    );
    if (insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });
 
    await updateRecord('portable_charger_booking', { status : 'C' }, ['booking_id'], [booking_id]);
    await createportableChargerInvoice(rider_id, booking_id); 
    const href    = `portable_charger_booking/${booking_id}`;
    const title   = 'Portable Charging Booking!';
    const message = `Booking Cancelled : ${booking_id}`;
    await createNotification(title, message, 'Portable Charging Booking', 'Admin', 'Rider',  rider_id, '', href);
 
    if(checkOrder.rsa_id ||  checkOrder.rsa_id!=null) {
        await db.execute(`DELETE FROM portable_charger_booking_assign WHERE order_id=? AND rider_id=?`, [booking_id, rider_id]);
        pushNotification(checkOrder.rsa_fcm_token, title, message, 'RSAFCM', href); 
        const RSAhtml = `<html>
            <body>
                <h4>Dear ${checkOrder.rsa_name},</h4>
                <p>This is to inform you that a user has cancelled their booking for the mobile & portable EV charging service. Please find the details below:</p>
                <p>Booking Details:</p>
                <p>Customer Name       : ${checkOrder.user_name}</p>
                <p>Contact No          : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                <p>Address             : ${checkOrder.address}</p>
                <p>Service Date & Time : ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}  </p> 
                <p>Vehicle Details     : ${checkOrder.vehicle_data}</p>
                <p>Thank you for your attention to this update.</p>
                <p>Best regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
        // emailQueue.addEmail(checkOrder.rsa_email, `Portable Charger Service Booking Cancellation (Booking ID: ${booking_id} ) `, RSAhtml); 
        emailQueue.addEmail(checkOrder.rsa_email, `Mobile & Portable EV Charging Service Booking Cancellation (Booking ID: ${booking_id} ) `, RSAhtml);
     }
    const html = `<html>
        <body>
            <h4>Dear ${checkOrder.user_name},</h4>
            <p>We would like to inform you that your booking for the mobile & portable EV charging service has been successfully cancelled. Below are the details of your cancelled booking:</p>
            <p>Booking ID    : ${booking_id}</p>
            <p>Date and Time : ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}</p>
            <p>Thank you for using PlusX Electric. We look forward to serving you again soon.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(checkOrder.rider_email, `PlusX Electric App: Booking Cancellation`, html);
    const adminHtml = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>This is to inform you that a user has cancelled their booking for the mobile & portable EV charging service. Please find the details below:</p>
            <p>Booking Details:</p>
            <p>Customer Name       : ${checkOrder.user_name}</p>
            <p>Contact No          : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
            <p>Address             : ${checkOrder.address}</p>
            <p>Service Date & Time : ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}  </p> 
            <p>Vehicle Details     : ${checkOrder.vehicle_data}</p>
            <p>Thank you for your attention to this update.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Mobile & Portable EV Charging Service Booking Cancellation ( Booking ID : ${booking_id} )`, adminHtml); 
    io.emit('notification-list', {msCount : 1});
    return resp.json({ message: ['Your booking has been successfully cancelled.'], status: 1, code: 200 });
});

export const userFeedbackPCBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, description ='', rating } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        booking_id : ["required"],
        rating     : ["required"],  
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT 
            rsa_id, user_name 
        FROM 
            portable_charger_booking
        WHERE 
            booking_id = ? AND rider_id = ? AND status IN ('CC', 'PU', 'RO')
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const feedbackCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_booking_feedback WHERE rider_id = ? AND booking_id = ?',[rider_id, booking_id]
    );
    if (feedbackCount.count === 0) {
       
        const insert = await insertRecord('portable_charger_booking_feedback', [
            'booking_id', 'rider_id', 'rsa_id', 'rating', 'description'
        ],[
            booking_id, rider_id, checkOrder.rsa_id, parseInt(rating), description
        ]);
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });
        
        const href    = `portable_charger_booking/${booking_id}`;
        // const title   = 'Portable Charger Feedback!';
        // const message = `Feedback Received - Booking ID: ${booking_id}.`;
        const title   = `Feedback Received- ${booking_id}`;
        const message = `You've received feedback from a customer`;
        await createNotification(title, message, 'Portable Charging Booking', 'Admin', 'Rider', rider_id, '', href);

        const adminHtml = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>You have received feedback from a customer via the PlusX app.</p>
                <p>Customer Name : ${checkOrder.user_name}</p>
                <p>Booking ID    : ${booking_id}</p>
                <p>Rating        : ${ parseInt(rating) }</p> 
                <p>Feedback      : ${description}</p>
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

export const reScheduleBooking = asyncHandler(async (req, resp) => {
    
    const { rider_id, booking_id, slot_date, slot_time, slot_id, device_name } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id        : ["required"],
        booking_id      : ["required"],
        slot_date       : ["required"],
        slot_time       : ["required"],
        slot_id         : ["required"],
        device_name     : ["required"],
    });  
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    // const conn = await startTransaction();
    try {
        const fSlotDateTime = moment(slot_date + ' ' + slot_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss')
        const currDateTime  = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});

        const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');

        // 1. Lock all bookings for this slot
        const [lockedRows] = await db.execute(
            `SELECT
                id
            FROM 
                portable_charger_booking
            WHERE
                slot_time = ? AND slot_date = ?  AND  status NOT IN ('C')
            FOR UPDATE`,
            [slot_time, fSlotDate]  // 'PU', 'RO' 
        ); //, 'PNR'
        const bookingCount = lockedRows.length;

        const [slotLimitRows] = await db.execute( `
            SELECT
                booking_limit
            FROM 
                portable_charger_slot
            WHERE
                slot_date = ? AND start_time = ? LIMIT 1 
            FOR UPDATE`,
            [fSlotDate, slot_time]
        );
        if (slotLimitRows.length === 0) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        }
        const bookingLimit = slotLimitRows[0].booking_limit;
        if (bookingCount >= bookingLimit) {
            return resp.json({ message : ["The slot you selected has already been booked. Please select another slot"], status: 0, code: 422, error: true });
        }
        const checkOrder = await queryDB(`
            SELECT
                pcb.user_name, pcb.country_code, pcb.contact_no, pcb.address, pcb.latitude, pcb.longitude,
                pcb.rescheduled_booking, pcb.slot_date, pcb.slot_time, rd.fcm_token, rd.rider_email, 
                pcb.vehicle_data, rsa.rsa_name, rsa.fcm_token as rsa_fcm_token, rsa.email as rsa_email, pcb.rsa_id
            FROM 
                portable_charger_booking as pcb
            LEFT JOIN
                riders AS rd ON rd.rider_id = pcb.rider_id
            LEFT JOIN
                rsa ON rsa.rsa_id = pcb.rsa_id
            WHERE 
                pcb.booking_id = ? AND pcb.rider_id = ?
            LIMIT 1
        `,[
            booking_id, rider_id
        ]);
        if (!checkOrder) {
            return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
        }
        if (checkOrder.rescheduled_booking) {
            return resp.json({ message: [`This booking has already been rescheduled.`], status: 0, code: 404 });
        }
        const oldSlotDateTime = moment(checkOrder.slot_date + ' ' + checkOrder.slot_time, 'YYYY-MM-DD HH:mm:ss'); //.format('YYYY-MM-DD HH:mm:ss');
        let prevDay  = oldSlotDateTime.subtract(24, 'hours').format('YYYY-MM-DD HH:mm:ss');

        if (currDateTime > prevDay ) {
            return resp.json({
                message: ["Apologies, rescheduling is only allowed up to 24 hours before the scheduled service time."],
                status : 0,
                code   : 405,
                error  : true
            })
        }   
        //  return resp.json({status:0, code:200, message: ["Ravi Oops! Something went wrong. Please try again."]});
        const updtFields = {
            status              : 'CNF', 
            slot                : slot_id, 
            slot_date           : fSlotDate, 
            slot_time           : slot_time,
            device_name         : device_name,
            rescheduled_booking : 1
        }
        await updateRecord('portable_charger_booking', updtFields, ['booking_id', 'rider_id'], [booking_id, rider_id]); //, conn 
        await updateRecord('portable_charger_booking_assign', { slot_date_time : fSlotDateTime }, ['order_id', 'rider_id'], [booking_id, rider_id]);
        const insert = await insertRecord('portable_charger_history', ['booking_id', 'rider_id', 'order_status'], [booking_id, rider_id, 'CNF']);
        
        if(insert.affectedRows == 0) return resp.json({status:0, code:200, message: ["Oops! Something went wrong. Please try again."]});

        const href    = 'portable_charger_booking/' + booking_id;
        const heading = 'Portable Charging Booking!';
        const desc    = `Rescheduled Booking Confirmed! ${booking_id}`;
        createNotification(heading, desc, 'Portable Charging Booking', 'Rider', 'Admin','', rider_id, href);
        createNotification(heading, desc, 'Portable Charging Booking', 'Admin', 'Rider',  rider_id, '', href);
        pushNotification(checkOrder.fcm_token, heading, desc, 'RDRFCM', href);
    
        const htmlUser = `<html>
            <body>
                <h4>Dear ${checkOrder.user_name},</h4>
                <p>We would like to confirm that your booking for the mobile & portable EV charging service has been successfully rescheduled. Please find the updated details below:</p>
                
                <p>Booking ID: ${booking_id}</p>
                <p>Rescheduled Date & Time : ${moment(fSlotDate, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(slot_time, 'HH:mm').format('h:mm A')}</p>

                <p>Thank you for choosing PlusX Electric. If you have any questions or need further assistance, feel free to contact us.</p>                  
                <p>Best regards,<br/> PlusX Electric Team </p>
            </body>
        </html>`;
        emailQueue.addEmail(checkOrder.rider_email, `Booking Rescheduled Successfully - ${booking_id}`, htmlUser);
        const htmlAdmin = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>This is to inform you that a user has rescheduled their mobile & portable EV charging service booking. Please find the updated booking details below:</p> 
                <p>User Name       : ${checkOrder.user_name}</p>
                <p>User Contact    : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                <p>Booking ID      : ${booking_id}</p>
                <p>New Scheduled Date & Time : ${moment(fSlotDate, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(slot_time, 'HH:mm').format('h:mm A')}</p>
                <p>Location        : ${checkOrder.address}</p>       
                <p>Vechile Details : ${checkOrder.vehicle_data}</p>
                <a href="https://www.google.com/maps?q=${checkOrder.latitude},${checkOrder.longitude}">Address Link</a><br>
                <p>Best regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
        emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Mobile & Portable EV Charging Service Booking Rescheduled (Booking ID : ${booking_id} )`, htmlAdmin);
        
        if(checkOrder.rsa_id ){
 
            pushNotification(checkOrder.rsa_fcm_token, heading, desc, 'RSAFCM', href);
           
            const htmlDriver = `<html>
                <body>
                    <h4>Dear ${checkOrder.rsa_name},</h4>
                    <p>This is to inform you that a user has rescheduled their mobile & portable EV charging service booking. Please find the updated booking details below:</p>
                    
                    <p>User Name       : ${checkOrder.user_name}</p>
                    <p>User Contact    : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                    <p>Booking ID      : ${booking_id}</p>
                    <p>New Scheduled Date & Time : ${moment(fSlotDate, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(slot_time, 'HH:mm').format('h:mm A')}</p>
                    <p>Location        : ${checkOrder.address}</p>       
                    <p>Vechile Details : ${checkOrder.vehicle_data}</p>
                    <a href="https://www.google.com/maps?q=${checkOrder.latitude},${checkOrder.longitude}">Address Link</a><br>
                    <p>Best regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(checkOrder.rsa_email, `Mobile & Portable EV Charging Service Booking Rescheduled (Booking ID: ${booking_id})`, htmlDriver);
        }
        let respMsg = "Booking request received! Your booking has been successfully rescheduled. Our team will arrive at the updated time.";

        io.emit('notification-list', {msCount : 1});
        return resp.json({
            status        : 1, 
            code          : 200,
            booking_id    : booking_id,
            message       : [respMsg] 
        });

    } catch(err) {
        // await rollbackTransaction(conn);
        tryCatchErrorHandler(req.originalUrl, err, resp);
        console.error("Transaction failed:", err);
    } finally {
        // if (conn) conn.release();
    }
});

const makeBookingHistory = async (history) => {
    const bookingStatus =  [
        { "order_status" : "CNF", "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "RS", "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "C",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "A",   "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "ER",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "RL",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "CS",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        { "order_status" : "CC",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
        // { "order_status" : "PU",  "rsa_id" : null, "created_at" : null, "rsa_name": null, status : 0 },
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
    updatedList     = updatedList.filter( item => !(item.order_status === 'RS' && item.status === 0) );
    return updatedList; 
}