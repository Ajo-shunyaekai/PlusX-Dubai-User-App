import generateUniqueId from "generate-unique-id";
import { mergeParam, formatDateTimeInQuery, asyncHandler, } from "../../utils.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import db from "../../config/db.js";
import moment from "moment-timezone";

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";

import client  from "../../server.js";

export const chargingStart = async (req, resp) => {
    try {
        const { rider_id, charger_id } = mergeParam(req); 
        
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id   : ["required"],
            charger_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
         
        const chargeData = await queryDB(`
            SELECT 
                cr.resident_id, cr.resident_name, cr.resident_mobile, cr.resident_email, cr.address,
                cr.monthly_session_allocation, cr.alloted_time, cr.kwh_allocated, cr.per_kwh_charge,
                cr.extra_charge, r.rider_mobile, cl.community_name, cl.area_name
            FROM community_chargers AS cm
            LEFT JOIN riders AS r ON r.rider_id = ?
            LEFT JOIN community_list AS cl ON cl.community_id = cm.community_id 
            LEFT JOIN community_resident AS cr
                ON cr.community_id = cm.community_id AND cr.resident_mobile = r.rider_mobile
            WHERE cm.charger_id = ?
            LIMIT 1 `, [ rider_id, charger_id]  //community_id
        );
        if(!chargeData) return resp.json({ message : ["Charger Id not valid!"], status: 0, code: 422, error: true });

        if(!chargeData.monthly_session_allocation) return resp.json({ message : ["The provided charger ID is not mapped to your community."], status: 0, code: 422, error: true });

        const startDate = moment().startOf("month").subtract(4, "hours").format("YYYY-MM-DD HH:mm:ss");
        const endDate   = moment().endOf("month").subtract(4, "hours").format("YYYY-MM-DD HH:mm:ss");
        
        //Existing query skipped  checks for new riders with 0 bookings
        // const bookingData = await queryDB(`
        //     SELECT
        //         scb.status, 
        //         ( SELECT COUNT(*) FROM scan_charger_booking WHERE rider_id = ? AND created_at BETWEEN ? AND ? ) AS total_session,
        //         ( SELECT COUNT(*) FROM scan_charger_booking WHERE charger_id = ? AND status = ? ) AS chek_charger_booking 
        //     FROM scan_charger_booking scb
        //     WHERE scb.rider_id = ? 
        //     LIMIT 1`,  [ rider_id, startDate, endDate, charger_id, "S", rider_id ]
        // );
        // if( bookingData && bookingData.status == "S" ){ 
        //     return resp.json({ message : ["A booking is currently running. Please end the current session before creating a new booking."], status: 0, code: 422, error: true });
        // }
        // if( bookingData && bookingData.chek_charger_booking ){
        //     return resp.json({ message : ["The charger is already occupied"], status: 0, code: 422, error: true });
        // }
        // if( bookingData && bookingData.total_session >= chargeData.monthly_session_allocation ){ 
        //     return resp.json({ message : ["You have reached the maximum number of allowed sessions."], status: 0, code: 422, error: true });
        // }

        // Fixed: always returns one row of counts 
        const sessionChecks = await queryDB(`
            SELECT
                ( SELECT COUNT(*) FROM scan_charger_booking WHERE rider_id = ? AND status = ? ) AS active_session,
                ( SELECT COUNT(*) FROM scan_charger_booking WHERE rider_id = ? AND created_at BETWEEN ? AND ? AND status <> 'F' ) AS total_session,
                ( SELECT COUNT(*) FROM scan_charger_booking WHERE charger_id = ? AND status = ? ) AS chek_charger_booking
            `, [ rider_id, "S", rider_id, startDate, endDate, charger_id, "S" ]
        );
        if( sessionChecks?.active_session > 0 ){ 
            return resp.json({ message : ["A booking is currently running. Please end the current session before creating a new booking."], status: 0, code: 422, error: true });
        }
        if( sessionChecks?.chek_charger_booking > 0 ){
            return resp.json({ message : ["The charger is already occupied"], status: 0, code: 422, error: true });
        }
        if( sessionChecks?.total_session >= chargeData.monthly_session_allocation ){ 
            return resp.json({ message : ["You have reached the maximum number of allowed sessions."], status: 0, code: 422, error: true });
        }
        if( chargeData.resident_mobile != chargeData.rider_mobile ) {
            return resp.json({ message : ["The user is not registered as a resident of this community."], status: 0, code: 422, error: true });
        }
        const chargeMeterData = await queryDB(`
            SELECT energy
            FROM scan_charger_data
            WHERE charger_id = ? AND updated_at >= NOW() - INTERVAL 5 MINUTE
            ORDER BY id DESC
            LIMIT 1 `, [ charger_id] 
        );
        if(!chargeMeterData) {

            const contentData = await queryDB(`
                SELECT content, additional_content as contact_no
                FROM response_content
                WHERE module_name = ? AND response_type = ? AND status = 1
                ORDER BY id DESC
                LIMIT 1 `, [ "scan-charger", "offline" ] 
            );
            return resp.json( { status : 0, code : 201, message : [ contentData.content ], teamContactNo : contentData.contact_no } );
        }
        const total_consumption = 0;
        const total_duration    = 0;
        const extra_minutes     = 0;
        const start_time        = moment().tz('Asia/Dubai').format("YYYY-MM-DD HH:mm:ss");
        const end_time          = null;
        const start_kwh         = chargeMeterData?.energy || 0;
        const end_kwh           = 0;
        const resident_data = {
            community_name  : chargeData.community_name,
            area_name       : chargeData.area_name,  
            resident_id     : chargeData.resident_id,  
            resident_name   : chargeData.resident_name,  
            resident_mobile : chargeData.resident_mobile,  
            resident_email  : chargeData.resident_email, 

            address                    : chargeData.address, 
            monthly_session_allocation : chargeData.monthly_session_allocation, 
            alloted_time               : chargeData.alloted_time, 
            kwh_allocated              : chargeData.kwh_allocated,  
            per_kwh_charge             : chargeData.per_kwh_charge,
            extra_charge               : chargeData.extra_charge, 
        }
        const insert = await insertRecord('scan_charger_booking',
            [
                'booking_id', 'rider_id', 'charger_id', 'total_consumption', 'total_duration', 'extra_minutes', 
                'start_time', 'end_time', 'start_kwh', 'end_kwh', 'resident_data', 'status'
            ], [
                "booking_id", rider_id, charger_id, total_consumption, total_duration, extra_minutes,
                start_time, end_time, start_kwh, end_kwh, resident_data, "S" 
            ]
        );
        if(insert.affectedRows == 0) return resp.json({ status : 0, message : "Failed to Start Charge! Please try again after some time."});
        
        const booking_id = 'SCB' + String(insert.insertId).padStart(4, '0');
        await updateRecord('scan_charger_booking', { booking_id : booking_id }, ['id'], [insert.insertId] );

        client.publish(`/supro/EVONE/${charger_id}/DL/RL`, "ON", { qos: 0, retain: false });

        setTimeout(() => {
            startChargingCheck (charger_id, booking_id );
        }, 3 * 60 * 1000);

        return resp.json({ booking_id, status : 1, code : 200, message : [ "Charging started successfully, you can track real-time speed on the app."] });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};

export const startChargingCheck = async (charger_id, booking_id) => {
    try {
        const chargingData = await queryDB(`
            SELECT 
                start_time, start_kwh,
                (SELECT energy from scan_charger_data WHERE charger_id = ? ORDER BY id DESC LIMIT 1 ) as energy 
            FROM scan_charger_booking b 
            WHERE booking_id = ? AND b.status = ? AND b.created_at >= NOW() - INTERVAL 4 MINUTE
            LIMIT 1 `, [ charger_id, booking_id, 'S' ]
        );
        if(!chargingData) return false;

        const currentReading     = chargingData?.energy || 0;
        const charging_start_kwh = chargingData?.start_kwh || 0;
        const total_consumption  = parseFloat(currentReading) - parseFloat(charging_start_kwh);

        if( total_consumption == 0 ) {

            const start_time     = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss", "Asia/Dubai");
            const end_time       = moment().subtract(1, "hour").subtract(30, "minutes"); // moment().add(4, 'hours');
            const diffInMinutes  = end_time.diff(start_time, "minutes");        
              
            const updates = {
                total_consumption, 
                total_duration : diffInMinutes, 
                end_time       : moment(end_time, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"), 
                end_kwh        : currentReading,
                status         : "F"
            };
            await updateRecord('scan_charger_booking', updates, ['booking_id'], [ booking_id ]);

            client.publish(`/supro/EVONE/${charger_id}/DL/RL`, "OFF", { qos: 0, retain: false });
            
            return true;

        } else {
            return false;
        }
    } catch(err) {
        console.log(err);
        tryCatchErrorHandler('boking check-verify-otp', err, []);
        return false; 
    }
}

export const stopCharge = async (req, resp) => {
    try {
        const { rider_id, booking_id } = mergeParam(req); 
        
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id   : ["required"],
            booking_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const chargingData = await queryDB(`
            SELECT 
                charger_id, start_time, start_kwh, resident_data
            FROM scan_charger_booking
            WHERE booking_id = ? AND status = ?
            LIMIT 1 `, [ booking_id, "S" ]
        );
        if(!chargingData) return resp.json({ message : ["No charging activity was recorded"], status: 0, code: 422, error: true });

        const chargeData = await queryDB(`
            SELECT energy
            FROM scan_charger_data
            WHERE charger_id = ?
            ORDER BY id DESC
            LIMIT 1 `, [ chargingData.charger_id] 
        );
        const currentReading = chargeData?.energy || 0;
        const start_time    = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss", "Asia/Dubai");
        const end_time      = moment().subtract(1, "hour").subtract(30, "minutes"); // moment().add(4, 'hours');
        const diffInMinutes = end_time.diff(start_time, "minutes");

        const resident_data     = chargingData?.resident_data;
        const alloted_time      = resident_data.alloted_time;
        
        const total_consumption = ( parseFloat(currentReading) - parseFloat(chargingData.start_kwh)).toFixed(2);
        const total_duration    = diffInMinutes;
        const extra_minutes     = diffInMinutes > alloted_time ? parseFloat(diffInMinutes) - parseFloat(alloted_time) : 0;
        const end_kwh           = currentReading;

        const updates = {
            total_consumption, 
            total_duration, 
            extra_minutes,
            end_time : moment(end_time, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"), 
            end_kwh,
            status : "C"
        };
        const insert = await updateRecord('scan_charger_booking', updates, ['booking_id'], [ booking_id ]);
        
        if(insert.affectedRows == 0) return resp.json({status:0, message: "Failed to Stop Charge! Please try again after some time."});
 
        client.publish(`/supro/EVONE/${chargingData.charger_id}/DL/RL`, "OFF", { qos: 0, retain: false });
        return resp.json({ status : 1, code : 200, message : [ "Charging Stop successfully."] });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};

export const chargingDetail = async (req, resp) => {
    try {
        const { rider_id, booking_id } = mergeParam(req);         
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id   : ["required"],
            booking_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const chargingData = await queryDB(`
            SELECT 
                start_time, start_kwh, charger_id, status, 
                JSON_UNQUOTE(JSON_EXTRACT(resident_data, '$.per_kwh_charge')) AS per_kwh_charge
            FROM scan_charger_booking
            WHERE booking_id = ? 
            LIMIT 1 `, [ booking_id ]  // , "S"    AND status = ?
        );
        if(!chargingData) return resp.json({ message : ["No charging activity was recorded"], status: 0, code: 422, error: true });
        
        if(chargingData.status == "F") {
             
            const [contentData] = await db.execute(`
                SELECT content, sub_module
                FROM response_content
                WHERE module_name = ? AND sub_module IN (?, ?) AND status = 1
                ORDER BY id DESC `, [ "scan-charger", "Possible reasons:", "What you can do:" ] 
            );
            const grouped = {};
            for (const { sub_module, content } of contentData) {
                if (!grouped[sub_module]) {
                    grouped[sub_module] = { sub_module, contents : [] };
                }
                grouped[sub_module].contents.push(content);
            }
            const result = Object.values(grouped);
            return resp.json( { status : 0, code : 201, message : result } );
        }
        const chargeData = await queryDB(`
            SELECT energy, power, charger_max_speed
            FROM scan_charger_data
            WHERE charger_id = ?
            ORDER BY id DESC
            LIMIT 1 `, [ chargingData.charger_id] 
        );
        const currentReading  = chargeData?.energy || 0;

        const start_time    = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss");
        const end_time      = moment().subtract(1, "hour").subtract(30, "minutes"); // moment().add(4, 'hours');
        const diffInMinutes = end_time.diff(start_time, "minutes");

        const total_consumption = parseFloat(currentReading) - parseFloat(chargingData?.start_kwh);
        const total_duration    = diffInMinutes;
        // const resident_data     = chargingData?.resident_data;

        const per_kwh_charge = chargingData?.per_kwh_charge || 0;   // ss
        const session_cost   = (per_kwh_charge * total_consumption ).toFixed(2)

        const returnObj = {
            charger_id        : chargingData?.charger_id,
            reat_time_speed   : ( ( chargeData?.power / 1000 ) || 0 ).toFixed(2),
            charger_max_speed : chargeData?.charger_max_speed || 0, // ye community_chargers  ka kw  hoga 
            energy_added      : total_consumption.toFixed(2),
            session_time      : total_duration,
            session_cost      : session_cost,
            start_time        : moment(start_time).format("YYYY-MM-DD HH:mm:ss")
        }
        return resp.json({ status : 1, code : 200, message : [ "Charging Data"], data : returnObj });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};

export const chargingHistory = async (req, resp) => {
    try {
        const { rider_id, resident_mobile, page_no = 1, limit = 2 } = mergeParam(req); 
        
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id        : ["required"],
            resident_mobile : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const residentData = await queryDB(`
            SELECT 
                monthly_session_allocation,
                (SELECT COUNT(*) from scan_charger_booking WHERE rider_id = ? ) as used_session
            FROM community_resident
            WHERE resident_mobile = ?
            LIMIT 1 `, [ rider_id, resident_mobile ]
        );
        if(!residentData) return resp.json({ message : ["No Resident found"], status: 0, code: 200, error: true });
        
        const offset   = (page_no - 1) * limit;
        const [chargingData] = await db.execute(`
            SELECT SQL_CALC_FOUND_ROWS booking_id, ${formatDateTimeInQuery(['created_at'])}, total_consumption, total_duration
            FROM scan_charger_booking
            WHERE rider_id = ? AND status = ?
            ORDER BY id DESC 
            LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [ rider_id, "C" ]
        );
        const [[{ total }]] = await db.query('SELECT FOUND_ROWS() AS total');
        const totalPage = Math.max(Math.ceil(total / limit), 1);

        const returnObj = {
            total_session   : residentData?.monthly_session_allocation,
            used_session    : residentData?.used_session,
            pending_session : (residentData?.monthly_session_allocation  - residentData?.used_session).toFixed(0),
            session_list    : chargingData,
            total, totalPage
        }
        return resp.json({ status : 1, code : 200, message : [ "Charging Data"], data : returnObj });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};

export const scanChargeInvoices = async (req, resp) => {
    try {
        const { rider_id, page_no =1, limit = 10 } = mergeParam(req); 
        
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const offset        = (page_no - 1) * limit;
        const [invoiceData] = await db.execute(`
            SELECT SQL_CALC_FOUND_ROWS 
                invoice_id, invoice_status, no_of_session, total_consumption, total_amount, 
                ${formatDateTimeInQuery(['created_at'])}
            FROM scan_charger_invoice
            WHERE rider_id = ?
            ORDER BY id DESC
            LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [ rider_id ]
        );
        const [[{ total }]] = await db.query('SELECT FOUND_ROWS() AS total');
        const totalPage = Math.max(Math.ceil(total / limit), 1);

        const returnObj = {
            invoice_list : invoiceData,
            total, totalPage
        }
        return resp.json({ status : 1, code : 200, message : [ "Charging Data"], data : returnObj });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};

export const scanChargeInvoiceDetail = async (req, resp) => {
    try {
        const { rider_id, invoice_id } = mergeParam(req); 
        
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id : ["required"],
            invoice_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const invoiceData = await queryDB(`
            SELECT 
                invoice_id, invoice_status,
                resident_name, resident_email, resident_address, no_of_session, total_consumption, over_time_min,
                per_kwh_charge, extra_charge_per_min, 
                energy_price_total, extra_charge_total, subtotal, vat, total_amount, invoice_status,
                ${formatDateTimeInQuery(['created_at'])}
            FROM scan_charger_invoice
            WHERE rider_id = ? AND invoice_id = ? `, [ rider_id, invoice_id ]
        );
        if(!invoiceData) return resp.json({ message : ["No invoice was found"], status: 0, code: 422, error: true });

        return resp.json({ status : 1, code : 200, message : [ "Invoice Data"], data : invoiceData });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};
 