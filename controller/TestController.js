import path from 'path';
import { fileURLToPath } from 'url';
// import transporter from '../mailer.js';
// import fs from "fs";
import { insertRecord, queryDB, updateRecord } from '../dbUtils.js';
import db from "../config/db.js";  //, { startTransaction, commitTransaction, rollbackTransaction }

import moment from 'moment/moment.js';
import emailQueue from '../emailQueue.js';
import { createNotification, pushNotification, mergeParam } from '../utils.js';

import Stripe from "stripe";
import dotenv from 'dotenv';
dotenv.config();

import { tryCatchErrorHandler } from "../middleware/errorHandler.js";
import client, { io } from '../server.js'; // client: MQTT relay OFF for scan-charge cron

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const stripe     = new Stripe(process.env.STRIPE_SECRET_KEY);

export const getPaymentSessionData = async (req, resp) => {
    const { session_id } = mergeParam(req);
    
    try {
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.status === 'open') {  //'open',
            // await stripe.checkout.sessions.expire(session_id);
            console.log('Session expired successfully');
            return resp.json({ 
                status : 1, 
                message: `Checkout Session Expired! Your checkout session has expired. Please start a new booking to continue.` 
            });
        }
        if(session.status == 'complete') {
            return resp.json({ status : 0, message: 'Payment received!' }); //paymentdata : session, 

        } else {
            return resp.json({ 
                status : 1, 
                message: `Checkout Session Expired! Your checkout session has expired. Please start a new booking to continue.` 
            });
        }
    } catch (error) {
        return resp.json({ error : error.message });
    }
}

export const getPaymentdetails = async (req, resp) => {
    const {rider_id, payment_intent_id } = mergeParam(req);
    
    try {
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        
        if(paymentIntent.status == 'succeeded') { //succeeded 
            return resp.json({ status : 1, message: 'Payment received!', code : 200, content : '' }); //paymentdata : paymentIntent, 
        } else {
            // await stripe.paymentIntents.cancel(payment_intent_id);
            return resp.json({ status : 0, message: 'Payment Not received', code : 422, content : `Checkout Session Expired! Your checkout session has expired. Please start a new booking to continue.` });
        }
    } catch (error) {
        return resp.json({ error : error.message });
    }
}

export const stripeWebhook = async (request, response) => {
    
    const endpointSecret = process.env.STRIPE_WEBHOOKS_KEY;
    const sig            = request.headers['stripe-signature'];
    let event;
    // console.log('body :', request.body);
    try {
        event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
    } catch (err) {
        console.log('errmsg:', err.message);
        response.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }
    // Handle the event
    const bookingType     = event.data.object.metadata?.booking_type;
    const bookingId       = event.data.object.metadata?.booking_id;
    const userId          = event.data.object.metadata?.user_id;
    const couponCode      = event.data.object.metadata?.coupon_code;
    const sessionId       = event.data.object.id;
    const paymentIntentId = event.data.object.payment_intent || event.data.object.id;
    
    switch (event.type) {
        case 'checkout.session.async_payment_failed':
            const checkoutSessionAsyncPaymentFailed = event.data.object;
            // Then define and call a function to handle the event checkout.session.async_payment_failed
            break;
        case 'checkout.session.async_payment_succeeded':
            
            await BookingConfirm(bookingType, bookingId, paymentIntentId, couponCode);
            // Then define and call a function to handle the event checkout.session.async_payment_succeeded
            break;
        case 'checkout.session.completed':      
            
            await BookingConfirm(bookingType, bookingId, paymentIntentId, couponCode);
            // Then define and call a function to handle the event checkout.session.completed
            break;
        case 'payment_intent.succeeded':
            
            await BookingConfirm(bookingType, bookingId, paymentIntentId, couponCode);
            break;
        case 'checkout.session.expired':
            const checkoutSessionExpired = event.data.object;
            // Then define and call a function to handle the event checkout.session.expired
            break;
        // ... handle other event types
        default:
            console.log(`Unhandled event type ${event.data.object}`);
    }
    // Return a 200 response to acknowledge receipt of the event
    response.status(200).send('success');
    return;
};

const BookingConfirm = async (bookingType, bookingId, paymentIntentId, couponCode) =>  {
    
    switch (bookingType) {
        case 'PCB':
            await portableChargerBookingConfirm(bookingId, paymentIntentId, couponCode);
            break;
        case 'CS':
            await pickAndDropBookingConfirm(bookingId, paymentIntentId, couponCode);
            break;
        case 'RSA':
            await rsaBookingConfirm(bookingId, paymentIntentId, couponCode);
            break;
        default:
            console.log('Unknown booking type');
    }
    return false ;
}

const portableChargerBookingConfirm = async (booking_id, payment_intent_id, couponCode ) => {
    // const conn = await startTransaction();
    console.log('Webhooks POD')
    try { 
        const checkOrder = await queryDB(`
            SELECT pcb.rider_id, pcb.user_name, pcb.country_code, pcb.contact_no, pcb.slot_date, pcb.slot_time, pcb.address, pcb.latitude, pcb.longitude,
            pcb.service_type, rd.fcm_token, rd.rider_email, pcb.vehicle_data, pcb.current_percent
            FROM 
                portable_charger_booking as pcb
            LEFT JOIN
                riders AS rd ON rd.rider_id = pcb.rider_id
            WHERE 
                pcb.booking_id = ? AND pcb.status = 'PNR'
            LIMIT 1
        `,[ booking_id ]);
        if (!checkOrder) {
            return false;
        }
        const ordHistoryCount = await queryDB(
            'SELECT COUNT(*) as count FROM portable_charger_history WHERE booking_id = ? AND order_status = "CNF"',[booking_id]
        );
        if (ordHistoryCount.count === 0) { 

            const insert = await insertRecord('portable_charger_history', ['booking_id', 'rider_id', 'order_status'], [booking_id, checkOrder.rider_id, 'CNF']);

            if(insert.affectedRows == 0) return false;
            await updateRecord('portable_charger_booking', { status : 'CNF', payment_intent_id}, ['booking_id', 'rider_id'], [booking_id, checkOrder.rider_id] );

            if(couponCode){
                const coupon = await queryDB(`SELECT coupan_percentage FROM coupon WHERE coupan_code = ? LIMIT 1 `, [ couponCode ]); 
        
                let coupan_percentage = coupon.coupan_percentage ;
                await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id', 'coupan_percentage'], [couponCode, checkOrder.rider_id, booking_id, coupan_percentage]);
            }
            if (checkOrder.service_type.toLowerCase() === "get monthly subscription") {
                await db.execute('UPDATE portable_charger_subscriptions SET total_booking = total_booking + 1 WHERE rider_id = ?', [checkOrder.rider_id]);
            }
            const href    = 'portable_charger_booking/' + booking_id;
            const heading = 'Portable Charging Booking!';
            const desc    = `Booking Confirmed! ${booking_id}`;
            createNotification(heading, desc, 'Portable Charging Booking', 'Rider', 'Admin','', checkOrder.rider_id, href);
            createNotification(heading, desc, 'Portable Charging Booking', 'Admin', 'Rider',  checkOrder.rider_id, '', href);
            pushNotification(checkOrder.fcm_token, heading, desc, 'RDRFCM', href);
        
            const battery_percent  =   (checkOrder.current_percent == 1) ? 'More than 10%' : 'Less than 10%' ;
            const htmlUser = `<html>
                <body>
                    <h4>Dear ${checkOrder.user_name},</h4>
                    <p>Thank you for choosing our mobile & portable EV charging service for your EV. We are pleased to confirm that your booking has been successfully received.</p> 
                    <p>Booking Details:</p>
                    <p>Booking ID: ${booking_id}</p>
                    <p>Date and Time of Service: ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}</p>
                    <p>Vehicle Battery Percentages : ${battery_percent}</p>
                    <p>We look forward to serving you and providing a seamless EV charging experience.</p>
                    <p> Best regards,<br/>PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(checkOrder.rider_email, 'PlusX Electric App: Booking Confirmation for Your Mobile & Portable EV Charging Service', htmlUser);

            const htmlAdmin = `<html>
                <body>
                    <h4>Dear Admin,</h4>
                    <p>We have received a new booking for our mobile & portable EV charging service. Please find the details below:</p> 
                    <p>Customer Name : ${checkOrder.user_name}</p>
                    <p>Contact No.   : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                    <p>Address       : ${checkOrder.address}</p>            
                    <p>Service Date & Time : ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}</p>       
                    <p>Vechile Details : ${checkOrder.vehicle_data}</p>
                    <p>Vehicle Battery Percentages : ${battery_percent}</p> 
                    <a href="https://www.google.com/maps?q=${checkOrder.latitude},${checkOrder.longitude}">Address Link</a><br>
                    <p> Best regards,<br/>PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Portable Charger Booking - ${booking_id}`, htmlAdmin);
            
            io.emit('notification-list', {msCount : 1});
            
            return true;
        } else {
            return false;
        }

    } catch(err) {
        // await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        tryCatchErrorHandler('stripe-POD-confirm', err, []);
    } finally {
        // if (conn) conn.release();
        return true;
    }
};

const pickAndDropBookingConfirm = async (request_id, payment_intent_id, couponCode) => {
    // const conn = await startTransaction();
    console.log('WEbHooks Valet');
    try { 
        
        const checkOrder = await queryDB(`
            SELECT 
                cs.rider_id, cs.pickup_address, cs.pickup_latitude, cs.pickup_longitude, rd.fcm_token, cs.name, cs.slot_date_time, rd.rider_email, cs.vehicle_data, cs.country_code, cs.contact_no 
            FROM 
                charging_service as cs
            LEFT JOIN
                riders AS rd ON rd.rider_id = cs.rider_id
            WHERE 
                cs.request_id = ? AND cs.order_status = 'PNR'
            LIMIT 1
        `,[ request_id ] );

        if (!checkOrder) {
            return false;
        }
        const ordHistoryCount = await queryDB(
            'SELECT COUNT(*) as count FROM charging_service_history WHERE service_id = ? AND order_status = "CNF"',[request_id]
        );
        if (ordHistoryCount.count === 0) { 
            
            const insert = await insertRecord('charging_service_history', ['service_id', 'rider_id', 'order_status'], [request_id, checkOrder.rider_id, 'CNF']);
            
            if(insert.affectedRows == 0) return false;
            await updateRecord('charging_service', { order_status : 'CNF', payment_intent_id }, ['request_id', 'rider_id'], [request_id, checkOrder.rider_id] );
            if(couponCode){
                const coupon = await queryDB(`SELECT coupan_percentage FROM coupon WHERE coupan_code = ? LIMIT 1 `, [ couponCode ]); 
        
                let coupan_percentage = coupon.coupan_percentage ;
                await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id', 'coupan_percentage'], [couponCode, checkOrder.rider_id, request_id, coupan_percentage]);
            }
            const href    = 'charging_service/' + request_id;
            const heading = 'EV Pick Up & Drop Off Booking!';
            const desc    = `Booking Confirmed! ${request_id}`;
            createNotification(heading, desc, 'Charging Service', 'Rider', 'Admin','', checkOrder.rider_id, href);
            createNotification(heading, desc, 'Charging Service', 'Admin', 'Rider', checkOrder.rider_id, '', href);
            pushNotification(checkOrder.fcm_token, heading, desc, 'RDRFCM', href);
        
            const htmlUser = `<html>
                <body>
                    <h4>Dear ${checkOrder.name},</h4>
                    <p>Thank you for choosing our EV Pickup and Drop Off service. We are pleased to confirm that your booking has been successfully received.</p>
                    <p>Booking Details:</p>
                    
                    <p>Booking ID: ${request_id}</p>
                    <p>Service Date and Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</p>
                    <p>Address : ${checkOrder.pickup_address}</p>

                    <p>We look forward to serving you and providing a seamless EV experience.</p>   
                    <p>Best Regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(checkOrder.rider_email, 'PlusX Electric App: Booking Confirmation for Your EV Pickup and Drop Off Service', htmlUser);
            
            const htmlAdmin = `<html>
                <body>
                    <h4>Dear Admin,</h4>
                    <p>We have received a new booking for our EV Pickup and Drop-Off service. Please find the details below:</p> 

                    <p>Customer Name : ${checkOrder.name}</p>
                    <p>Contact No.   : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                    <p>Address       : ${checkOrder.pickup_address}</p>
                    <p>Service Date and Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}</p>
                    <p>Vehicle Details: ${checkOrder.vehicle_data}</p>
                
                    <a href="https://www.google.com/maps?q=${checkOrder.pickup_latitude},${checkOrder.pickup_longitude}">Address Link</a><br>           
                    <p>Best regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `EV Pickup and Drop-Off - ${request_id}`, htmlAdmin);
            io.emit('notification-list', {msCount : 1});
            return true
        } else {
            return false;
        }
    } catch(err) {
        // await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        tryCatchErrorHandler(err, []);
        return false;
    } finally {
        // if (conn) conn.release();
        return false
    }
};

const rsaBookingConfirm = async (request_id, payment_intent_id, couponCode) => {
    // const conn = await startTransaction();
    console.log('WEbHooks RSA');
    try { 
        const checkOrder = await queryDB(`
            SELECT 
                rsa.request_id, rsa.rider_id, rsa.name, rsa.country_code, rsa.contact_no, 
                rsa.pickup_address, rsa.pickup_latitude, rsa.pickup_longitude, 
                rd.fcm_token, rd.rider_email, rsa.vehicle_data, rsa.current_percent
            FROM 
                road_assistance as rsa
            LEFT JOIN
                riders AS rd ON rd.rider_id = rsa.rider_id
            WHERE 
                rsa.request_id = ?  AND rsa.order_status = 'PNR'
            LIMIT 1
        `,[ request_id ]);

        if (!checkOrder) {
            return false;
        }
        const ordHistoryCount = await queryDB(
            'SELECT COUNT(*) as count FROM order_history WHERE order_id = ? AND order_status = "CNF"',[request_id]
        );
        if (ordHistoryCount.count === 0) { 

            const insert = await insertRecord('order_history', ['order_id', 'order_status', 'rider_id'], [request_id, 'CNF', checkOrder.rider_id]);
            if(insert.affectedRows == 0) return false;
            
            await updateRecord('road_assistance', { order_status : 'CNF', payment_intent_id}, ['request_id', 'rider_id'], [request_id, checkOrder.rider_id] );
            if(couponCode){
                const coupon = await queryDB(`SELECT coupan_percentage FROM coupon WHERE coupan_code = ? LIMIT 1 `, [ couponCode ]); 
        
                let coupan_percentage = coupon.coupan_percentage ;
                await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id', 'coupan_percentage'], [couponCode, checkOrder.rider_id, request_id, coupan_percentage]);
            }
            
            const href    = 'road_assistance/' + request_id;
            const heading = 'EV Roadside Assistance';
            const desc    = `Booking Confirmed! ID : ${request_id}`;
            createNotification(heading, desc, 'Roadside Assistance', 'Rider', 'Admin','', checkOrder.rider_id, href);
            createNotification(heading, desc, 'Roadside Assistance', 'Admin', 'Rider',  checkOrder.rider_id, '', href);
            pushNotification(checkOrder.fcm_token, heading, desc, 'RDRFCM', href);
        
            const battery_percent  =   (checkOrder.current_percent == 1) ? 'More than 5%' : '0%' ;
            const htmlUser = `<html>
                <body>
                    <h4>Dear ${checkOrder.name},</h4>
                    <p>Thank you for choosing our Roadside Assistance service for your EV. We are pleased to confirm that your booking has been successfully received.</p> 
                    <p>Booking Details: </p>
                    <p>Booking ID: ${request_id}</p>
                    <p>Address: ${checkOrder.pickup_address}</p>
                    <p>Vehicle Battery Percentages : ${battery_percent}</p>  
                    <p>We look forward to serving you and providing a seamless EV charging experience.</p>
                    <p>Best regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            emailQueue.addEmail(checkOrder.rider_email, 'PlusX Electric App: Booking Confirmation for EV Roadside Assistance Service', htmlUser);
            const htmlAdmin = `<html>
                <body>
                    <h4>Dear Admin,</h4>
                    <p>We have received a new booking for the EV Roadside Assistance service. Please find the details below:</p>
                    <p>Customer Name  : ${checkOrder.name}</p>
                    <p>Contact No.    : ${checkOrder.country_code}-${checkOrder.contact_no}</p>
                    <p>Address        : ${checkOrder.pickup_address}</p>
                    <p>Vechile Details : ${checkOrder.vehicle_data}</p>
                    <p>Vehicle Battery Percentages : ${battery_percent}</p>  
                    <a href="https://www.google.com/maps?q=${checkOrder.pickup_latitude},${checkOrder.pickup_longitude}">Address Link</a><br>           
                    <p>Best regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            
            const adminEmails = [ 
                process.env.MAIL_POD_ADMIN, 
                process.env.MAIL_CHINTAN, 
                process.env.MAIL_NADIA, 
                process.env.MAIL_JAHID, 
                process.env.MAIL_JALAL, 
                process.env.MAIL_ABDUR, 
                process.env.MAIL_ZAKIR, 
                process.env.MAIL_JAVED, 
                process.env.MAIL_CHINTAN_SHUNYA 
            ];
            emailQueue.addEmail(adminEmails, `EV Roadside Assistance Booking - ${request_id}`, htmlAdmin);
            
            io.emit('notification-list', {msCount : 1});
            return true;
        } else {
            return false;
        }
    } catch(err) {
        // await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        tryCatchErrorHandler('RSA-booking-cnf', err, []);
    } finally {
        // if (conn) conn.release();
        return true;
    }
};

export const failedPODBooking = async () => {
    // const conn = await db.getConnection();
    try {
        // await conn.beginTransaction();
        // 1. Insert into destination table
        await db.query(`
            INSERT INTO failed_portable_charger_booking (booking_id, rider_id, vehicle_id, service_name, service_price, service_type, service_feature, user_name, country_code, contact_no, slot, slot_date, slot_time, address, latitude, longitude, status, address_alert, parking_number, parking_floor, address_id, device_name, payment_intent_id, vehicle_data)

            SELECT 
                booking_id, rider_id, vehicle_id, service_name, service_price, service_type, service_feature, user_name, country_code, contact_no, slot, slot_date, slot_time, address, latitude, longitude, status, address_alert, parking_number, parking_floor, address_id, device_name, payment_intent_id, vehicle_data 
            FROM 
                portable_charger_booking
            WHERE status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, 
        ['PNR']); 
    
        // 2. Delete from source table status payment_intent_id
        await db.query( `DELETE FROM portable_charger_booking WHERE status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, ['PNR'] );
    
        // await conn.commit();
        // console.log("POD Data moved successfully!");
        return "POD Data moved successfully!";
    
    } catch (err) {
        // await conn.rollback();
        console.error("Transaction failed:", err);
        tryCatchErrorHandler(err, []);
        return false;
    } finally {
        // conn.release();
        console.log("POD Data connection released");
        return "connection released";
    }
};

export const failedValetBooking = async () => {
    // const conn = await db.getConnection();
    try {
        // await conn.beginTransaction();
        // 1. Insert into destination table
        await db.query(`
            INSERT INTO failed_charging_service (request_id, rider_id, name, country_code, contact_no, vehicle_id, slot, slot_date_time, pickup_address, parking_number, parking_floor, price, order_status, pickup_latitude, pickup_longitude, device_name, payment_intent_id, vehicle_data)

            SELECT 
                request_id, rider_id, name, country_code, contact_no, vehicle_id, slot, slot_date_time, pickup_address, parking_number, parking_floor, price, order_status, pickup_latitude, pickup_longitude, device_name, payment_intent_id, vehicle_data 
            FROM 
                charging_service
            WHERE order_status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, 
        ['PNR']);
    
        // 2. Delete from source table status payment_intent_id
        await db.query( `DELETE FROM charging_service WHERE order_status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, ['PNR'] );
    
        // await conn.commit();
        // console.log("Valet Data moved successfully!");
        return "Valet Data moved successfully!";
    
    } catch (err) {
        // await conn.rollback();
        console.error("Transaction failed:", err);
        tryCatchErrorHandler('failed-valet-cron', err, []);
        return false;
    } finally {
        // conn.release();
        console.log("Valet Data connection released");
        return "connection released";
    }
};

export const failedRSABooking = async () => {
    // const conn = await db.getConnection();
    try {
        // await conn.beginTransaction();
        // 1. Insert into destination table
        
        await db.query(`
            INSERT INTO failed_road_assistance (request_id, rider_id, vehicle_id, price, name, country_code, contact_no, pickup_address, pickup_latitude, pickup_longitude, order_status, parking_number, parking_floor, address_id, device_name, payment_intent_id, vehicle_data)

            SELECT request_id, rider_id, vehicle_id, price, name, country_code, contact_no, pickup_address, pickup_latitude, pickup_longitude, order_status, parking_number, parking_floor, address_id, device_name, payment_intent_id, vehicle_data 
            FROM 
                road_assistance
            WHERE 
                order_status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, 
        ['PNR']);
    
        // 2. Delete from source table 
        await db.query( `DELETE FROM road_assistance WHERE order_status = ? AND created_at < NOW() - INTERVAL 6 MINUTE`, ['PNR'] );
    
        // await conn.commit();
        // console.log("RSA Data moved successfully!");
        return "RSA Data moved successfully!";
    
    } catch (err) {
        // await conn.rollback();
        console.error("Transaction failed:", err);
        tryCatchErrorHandler('failed-rsa-cron', err, []);
        return false;
    } finally {
        // conn.release();
        console.log("RSA Data connection released!");
        return "connection released";
    }
};

/**
 * Scan charge — 3-minute plug-in check (cron backup).
 *
 * chargingStart also schedules startChargingCheck via setTimeout after 3 min.
 * That timer is lost on server restart; this cron runs every minute so sessions
 * are still validated from the DB.
 *
 * Logic: status S + started >= 3 min ago → if energy did not increase vs start_kwh,
 * mark Failed (F) and turn charger relay OFF (not plugged in / no draw).
 */
export const scanChargePlugCheckCron = async () => {
    try {
        // Active sessions old enough to verify (same 3 min window as chargingStart)
        const [rows] = await db.execute(`
            SELECT
                b.booking_id,
                b.charger_id,
                b.start_kwh,
                b.start_time,
                (
                    SELECT scd.energy
                    FROM scan_charger_data scd
                    WHERE scd.charger_id = b.charger_id
                    ORDER BY scd.id DESC
                    LIMIT 1
                ) AS current_energy
            FROM scan_charger_booking b
            WHERE b.status = 'S'
              AND b.created_at <= NOW() - INTERVAL 3 MINUTE
        `);

        for (const row of rows) {
            const startKwh         = parseFloat(row.start_kwh) || 0;
            const currentReading   = parseFloat(row.current_energy) || 0;
            const totalConsumption = parseFloat(currentReading) - parseFloat(startKwh);

            // Energy increased → charging started; leave session as S
            if (totalConsumption != 0) continue;

            // Zero kWh delta → fail session (mirrors startChargingCheck in ScanChargeController)
            const start_time_moment = moment(row.start_time, "YYYY-MM-DD HH:mm:ss", "Asia/Dubai");
            const end_time            = moment().subtract(1, "hour").subtract(30, "minutes");
            const diffInMinutes       = end_time.diff(start_time_moment, "minutes");

            await updateRecord(
                "scan_charger_booking",
                {
                    total_consumption : totalConsumption,
                    total_duration    : diffInMinutes,
                    end_time          : moment(end_time, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"),
                    end_kwh           : currentReading,
                    status            : "F",
                },
                ["booking_id"],
                [row.booking_id]
            );

            client.publish(`/supro/EVONE/${row.charger_id}/DL/RL`, "OFF", { qos: 0, retain: false });
        }
    } catch (err) {
        console.error("scanChargePlugCheckCron error:", err);
        tryCatchErrorHandler("scan-charge-plug-check-cron", err, []);
    }
};