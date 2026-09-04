/**
 * Scan Charge Controller (multi-community)
 *
 * Data model:
 * - community_resident        → one row per resident (overall limits: sessions, time, kWh, pricing)
 * - community_resident_map    → many rows per resident (which communities they may charge at)
 *
 * Rules:
 * - Access: resident must have a map entry for the charger's community
 * - Limits: monthly session allocation is OVERALL (all communities combined), not per community
 *
 * ─── API params (unchanged from legacy app; no community_id required) ───
 *
 * GET  /resident-communities
 *   Query: rider_id (required)
 *
 * POST /start-scan-charge
 *   Body: rider_id (required), charger_id (required)
 *
 * POST /stop-scan-charge
 *   Body: rider_id (required), booking_id (required)
 *
 * GET  /scan-charge-detail
 *   Query: rider_id (required), booking_id (required)
 *
 * GET  /scan-charge-history
 *   Query: rider_id (required), resident_mobile (required), page_no (optional), limit (optional)
 *
 * GET  /scan-charge-invoice-list
 *   Query: rider_id (required), page_no (optional), limit (optional)
 *
 * GET  /scan-charge-invoice-detail
 *   Query: rider_id (required), invoice_id (required)
 */

import { mergeParam, formatDateTimeInQuery } from "../../utils.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import db from "../../config/db.js";
import moment from "moment-timezone";

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";

import client from "../../server.js";

/** Current billing month range (Dubai offset applied in legacy logic). */
const getMonthRange = () => {
    const startDate = moment().startOf("month").subtract(4, "hours").format("YYYY-MM-DD HH:mm:ss");
    const endDate   = moment().endOf("month").subtract(4, "hours").format("YYYY-MM-DD HH:mm:ss");
    return { startDate, endDate };
};

/**
 * GET /resident-communities
 * Optional display API — lists mapped communities; limits are returned once (overall pool).
 */
export const residentCommunities = async (req, resp) => {
    try {
        const { rider_id } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id: ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const residentLimits = await queryDB(`
            SELECT
                cr.resident_id,
                cr.monthly_session_allocation,
                cr.alloted_time,
                cr.kwh_allocated,
                cr.per_kwh_charge,
                cr.extra_charge
            FROM riders r
            INNER JOIN community_resident cr ON cr.resident_mobile = r.rider_mobile
            WHERE r.rider_id = ?
            LIMIT 1`, [rider_id]
        );

        if (!residentLimits) {
            return resp.json({
                status  : 1,
                code    : 200,
                message : ["Resident communities fetched successfully."],
                data    : { community_count: 0, communities: [] },
            });
        }

        const [communities] = await db.execute(`
            SELECT cl.community_id, cl.community_name, cl.area_name
            FROM community_resident cr
            INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
            INNER JOIN community_list cl ON cl.community_id = crm.community_id
            INNER JOIN riders r ON r.rider_mobile = cr.resident_mobile
            WHERE r.rider_id = ?
            ORDER BY cl.community_name ASC
        `, [rider_id]);

        return resp.json({
            status  : 1,
            code    : 200,
            message : ["Resident communities fetched successfully."],
            data    : {
                community_count            : communities.length,
                monthly_session_allocation : residentLimits.monthly_session_allocation,
                alloted_time               : residentLimits.alloted_time,
                kwh_allocated                : residentLimits.kwh_allocated,
                per_kwh_charge               : residentLimits.per_kwh_charge,
                extra_charge                 : residentLimits.extra_charge,
                communities,
            },
        });
    } catch (error) {
        console.log('Something went wrong in residentCommunities', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/**
 * POST /start-scan-charge
 * Access via community_resident_map; session limit counted across ALL communities.
 */
export const chargingStart = async (req, resp) => {
    try {
        const { rider_id, charger_id } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id   : ["required"],
            charger_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        // Map join ensures resident is allowed at this charger's community; limits from single resident row
        const chargeData = await queryDB(`
            SELECT
                cr.resident_id, cr.resident_name, cr.resident_mobile, cr.resident_email, cr.address,
                cr.monthly_session_allocation, cr.alloted_time, cr.kwh_allocated, cr.per_kwh_charge,
                cr.extra_charge, r.rider_mobile, cl.community_id, cl.community_name, cl.area_name
            FROM community_chargers AS cm
            INNER JOIN community_list AS cl ON cl.community_id = cm.community_id
            LEFT JOIN riders AS r ON r.rider_id = ?
            INNER JOIN community_resident AS cr ON cr.resident_mobile = r.rider_mobile
            INNER JOIN community_resident_map AS crm
                ON crm.resident_id = cr.resident_id AND crm.community_id = cm.community_id
            WHERE cm.charger_id = ?
            LIMIT 1`, [rider_id, charger_id]
        );

        if (!chargeData) {
            return resp.json({ message: ["Charger Id not valid!"], status: 0, code: 422, error: true });
        }

        if (!chargeData.monthly_session_allocation) {
            return resp.json({ message: ["The provided charger ID is not mapped to your community."], status: 0, code: 422, error: true });
        }

        if (chargeData.resident_mobile != chargeData.rider_mobile) {
            return resp.json({ message: ["The user is not registered as a resident of this community."], status: 0, code: 422, error: true });
        }

        const { startDate, endDate } = getMonthRange();

        // Overall monthly session count — sessions at any mapped community count toward the same limit
        const sessionChecks = await queryDB(`
            SELECT
                ( SELECT COUNT(*) FROM scan_charger_booking WHERE rider_id = ? AND status = ? ) AS active_session,
                ( SELECT COUNT(*) FROM scan_charger_booking
                  WHERE rider_id = ? AND created_at BETWEEN ? AND ? AND status <> 'F'
                ) AS total_session,
                ( SELECT COUNT(*) FROM scan_charger_booking WHERE charger_id = ? AND status = ? ) AS chek_charger_booking
        `, [rider_id, "S", rider_id, startDate, endDate, charger_id, "S"]
        );

        if (sessionChecks?.active_session > 0) {
            return resp.json({ message: ["A booking is currently running. Please end the current session before creating a new booking."], status: 0, code: 422, error: true });
        }
        if (sessionChecks?.chek_charger_booking > 0) {
            return resp.json({ message: ["The charger is already occupied"], status: 0, code: 422, error: true });
        }
        if (sessionChecks?.total_session >= chargeData.monthly_session_allocation) {
            return resp.json({ message: ["You have reached the maximum number of allowed sessions."], status: 0, code: 422, error: true });
        }

        const chargeMeterData = await queryDB(`
            SELECT energy
            FROM community_chargers
            WHERE charger_id = ? AND updated_at >= NOW() - INTERVAL 5 MINUTE
            LIMIT 1`, [charger_id]
        );

        if (!chargeMeterData) {
            const contentData = await queryDB(`
                SELECT content, additional_content as contact_no
                FROM response_content
                WHERE module_name = ? AND response_type = ? AND status = 1
                ORDER BY id DESC
                LIMIT 1`, ["scan-charger", "offline"]
            );
            return resp.json({ status: 0, code: 201, message: [contentData.content], teamContactNo: contentData.contact_no });
        }

        const start_time = moment().tz('Asia/Dubai').format("YYYY-MM-DD HH:mm:ss");
        // Snapshot resident config + charger community (for display on this session only)
        const resident_data = {
            community_id               : chargeData.community_id,
            community_name             : chargeData.community_name,
            area_name                  : chargeData.area_name,
            resident_id                : chargeData.resident_id,
            resident_name              : chargeData.resident_name,
            resident_mobile            : chargeData.resident_mobile,
            resident_email             : chargeData.resident_email,
            address                    : chargeData.address,
            monthly_session_allocation : chargeData.monthly_session_allocation,
            alloted_time               : chargeData.alloted_time,
            kwh_allocated              : chargeData.kwh_allocated,
            per_kwh_charge             : chargeData.per_kwh_charge,
            extra_charge               : chargeData.extra_charge,
        };

        const insert = await insertRecord('scan_charger_booking',
            [
                'booking_id', 'rider_id', 'charger_id', 'total_consumption', 'total_duration', 'extra_minutes',
                'start_time', 'end_time', 'start_kwh', 'end_kwh', 'resident_data', 'status'
            ], [
                "booking_id", rider_id, charger_id, 0, 0, 0,
                start_time, null, chargeMeterData?.energy || 0, 0, resident_data, "S"
            ]
        );

        if (insert.affectedRows == 0) {
            return resp.json({ status: 0, message: "Failed to Start Charge! Please try again after some time." });
        }

        const booking_id = 'SCB' + String(insert.insertId).padStart(4, '0');
        await updateRecord('scan_charger_booking', { booking_id }, ['id'], [insert.insertId]);

        client.publish(`/supro/EVONE/${charger_id}/DL/RL`, "ON", { qos: 0, retain: false });

        setTimeout(() => {
            startChargingCheck(charger_id, booking_id);
        }, 3 * 60 * 1000);

        return resp.json({
            booking_id,
            community_id : chargeData.community_id,
            status       : 1,
            code         : 200,
            message      : ["Charging started successfully, you can track real-time speed on the app."],
        });
    } catch (error) {
        console.log('Something went wrong in chargingStart', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/** Auto-fail session if no energy increase within ~3 minutes after start. */
export const startChargingCheck = async (charger_id, booking_id) => {
    try {
        const chargingData = await queryDB(`
            SELECT
                start_time, start_kwh,
                (SELECT energy FROM community_chargers WHERE charger_id = ? LIMIT 1) AS energy
            FROM scan_charger_booking b
            WHERE booking_id = ? AND b.status = ? AND b.created_at >= NOW() - INTERVAL 4 MINUTE
            LIMIT 1`, [charger_id, booking_id, 'S']
        );
        if (!chargingData) return false;

        const currentReading     = chargingData?.energy || 0;
        const charging_start_kwh = chargingData?.start_kwh || 0;
        const total_consumption  = parseFloat(currentReading) - parseFloat(charging_start_kwh);

        if (total_consumption == 0) {
            const start_time    = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss", "Asia/Dubai");
            const end_time      = moment().subtract(1, "hour").subtract(30, "minutes");
            const diffInMinutes = end_time.diff(start_time, "minutes");

            await updateRecord('scan_charger_booking', {
                total_consumption,
                total_duration : diffInMinutes,
                end_time       : moment(end_time, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"),
                end_kwh        : currentReading,
                status         : "F"
            }, ['booking_id'], [booking_id]);

            client.publish(`/supro/EVONE/${charger_id}/DL/RL`, "OFF", { qos: 0, retain: false });
            return true;
        }

        return false;
    } catch (err) {
        console.log(err);
        tryCatchErrorHandler('booking check-verify-otp', err, []);
        return false;
    }
};

/** POST /stop-scan-charge — Body: rider_id, booking_id */
export const stopCharge = async (req, resp) => {
    try {
        const { rider_id, booking_id } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id   : ["required"],
            booking_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const chargingData = await queryDB(`
            SELECT charger_id, start_time, start_kwh, resident_data
            FROM scan_charger_booking
            WHERE booking_id = ? AND rider_id = ? AND status = ?
            LIMIT 1`, [booking_id, rider_id, "S"]
        );
        if (!chargingData) {
            return resp.json({ message: ["No charging activity was recorded"], status: 0, code: 422, error: true });
        }

        const chargeData = await queryDB(`
            SELECT energy
            FROM community_chargers
            WHERE charger_id = ?
            LIMIT 1`, [chargingData.charger_id]
        );

        const currentReading = chargeData?.energy || 0;
        const start_time     = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss", "Asia/Dubai");
        const end_time       = moment().subtract(1, "hour").subtract(30, "minutes");
        const diffInMinutes  = end_time.diff(start_time, "minutes");
        const resident_data  = chargingData?.resident_data;
        const alloted_time   = resident_data.alloted_time;

        const updates = {
            total_consumption : (parseFloat(currentReading) - parseFloat(chargingData.start_kwh)).toFixed(2),
            total_duration    : diffInMinutes,
            extra_minutes     : diffInMinutes > alloted_time ? parseFloat(diffInMinutes) - parseFloat(alloted_time) : 0,
            end_time          : moment(end_time, "YYYY-MM-DD HH:mm:ss").format("YYYY-MM-DD HH:mm:ss"),
            end_kwh           : currentReading,
            status            : "C"
        };

        const insert = await updateRecord('scan_charger_booking', updates, ['booking_id'], [booking_id]);
        if (insert.affectedRows == 0) {
            return resp.json({ status: 0, message: "Failed to Stop Charge! Please try again after some time." });
        }

        client.publish(`/supro/EVONE/${chargingData.charger_id}/DL/RL`, "OFF", { qos: 0, retain: false });
        return resp.json({ status: 1, code: 200, message: ["Charging Stop successfully."] });
    } catch (error) {
        console.log('Something went wrong in stopCharge', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/** GET /scan-charge-detail — Query: rider_id, booking_id */
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
                JSON_UNQUOTE(JSON_EXTRACT(resident_data, '$.per_kwh_charge')) AS per_kwh_charge,
                JSON_UNQUOTE(JSON_EXTRACT(resident_data, '$.community_id')) AS community_id,
                JSON_UNQUOTE(JSON_EXTRACT(resident_data, '$.community_name')) AS community_name
            FROM scan_charger_booking
            WHERE booking_id = ? AND rider_id = ?
            LIMIT 1`, [booking_id, rider_id]
        );
        if (!chargingData) {
            return resp.json({ message: ["No charging activity was recorded"], status: 0, code: 422, error: true });
        }

        if (chargingData.status == "F") {
            const [contentData] = await db.execute(`
                SELECT content, sub_module
                FROM response_content
                WHERE module_name = ? AND sub_module IN (?, ?) AND status = 1
                ORDER BY id DESC`, ["scan-charger", "Possible reasons:", "What you can do:"]
            );
            const grouped = {};
            for (const { sub_module, content } of contentData) {
                if (!grouped[sub_module]) grouped[sub_module] = { sub_module, contents: [] };
                grouped[sub_module].contents.push(content);
            }
            return resp.json({ status: 0, code: 201, message: Object.values(grouped) });
        }

        const chargeData = await queryDB(`
            SELECT energy, power, charger_max_speed
            FROM community_chargers
            WHERE charger_id = ?
            LIMIT 1`, [chargingData.charger_id]
        );

        const currentReading    = chargeData?.energy || 0;
        const start_time        = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss");
        const end_time          = moment().subtract(1, "hour").subtract(30, "minutes");
        const diffInMinutes     = end_time.diff(start_time, "minutes");
        const total_consumption = parseFloat(currentReading) - parseFloat(chargingData?.start_kwh);
        const per_kwh_charge    = chargingData?.per_kwh_charge || 0;

        return resp.json({
            status  : 1,
            code    : 200,
            message : ["Charging Data"],
            data    : {
                booking_id        : booking_id,
                community_id      : chargingData.community_id,
                community_name    : chargingData.community_name,
                charger_id        : chargingData?.charger_id,
                reat_time_speed   : ((chargeData?.power / 1000) || 0).toFixed(2),
                charger_max_speed : chargeData?.charger_max_speed || 0,
                energy_added      : total_consumption.toFixed(2),
                session_time      : diffInMinutes,
                session_cost      : (per_kwh_charge * total_consumption).toFixed(2),
                start_time        : moment(start_time).format("YYYY-MM-DD HH:mm:ss"),
            },
        });
    } catch (error) {
        console.log('Something went wrong in chargingDetail', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/**
 * GET /scan-charge-history
 * Overall limits + all completed sessions (no community filter).
 * Params: rider_id, resident_mobile, page_no (optional), limit (optional)
 */
export const chargingHistory = async (req, resp) => {
    try {
        const { rider_id, resident_mobile, page_no = 1, limit = 2 } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id        : ["required"],
            resident_mobile : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const { startDate, endDate } = getMonthRange();
        const offset = (page_no - 1) * limit;

        const residentData = await queryDB(`
            SELECT
                cr.monthly_session_allocation,
                ( SELECT COUNT(*) FROM scan_charger_booking
                  WHERE rider_id = ? AND created_at BETWEEN ? AND ? AND status <> 'F'
                ) AS used_session
            FROM community_resident cr
            WHERE cr.resident_mobile = ?
            LIMIT 1`, [rider_id, startDate, endDate, resident_mobile]
        );

        if (!residentData) {
            return resp.json({ message: ["No Resident found."], status: 0, code: 422, error: true });
        }

        const [chargingData] = await db.execute(`
            SELECT SQL_CALC_FOUND_ROWS
                booking_id,
                ${formatDateTimeInQuery(['created_at'])},
                total_consumption,
                total_duration
            FROM scan_charger_booking
            WHERE rider_id = ? AND status = ?
            ORDER BY id DESC
            LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [rider_id, "C"]
        );

        const [[{ total }]] = await db.query('SELECT FOUND_ROWS() AS total');
        const totalPage = Math.max(Math.ceil(total / limit), 1);
        const pending_session = Math.max(residentData.monthly_session_allocation - residentData.used_session, 0);

        return resp.json({
            status  : 1,
            code    : 200,
            message : ["Charging Data"],
            data    : {
                total_session   : residentData.monthly_session_allocation,
                used_session    : residentData.used_session,
                pending_session : pending_session.toFixed(0),
                session_list    : chargingData,
                total,
                totalPage,
            },
        });
    } catch (error) {
        console.log('Something went wrong in chargingHistory', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/** GET /scan-charge-invoice-list — Query: rider_id, page_no (optional), limit (optional) */
export const scanChargeInvoices = async (req, resp) => {
    try {
        const { rider_id, page_no = 1, limit = 10 } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id: ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const offset = (page_no - 1) * limit;

        const [invoiceData] = await db.execute(`
            SELECT SQL_CALC_FOUND_ROWS
                sci.invoice_id,
                sci.invoice_status,
                sci.no_of_session,
                sci.total_consumption,
                sci.total_amount,
                sci.community_name,
                sci.area_name,
                ${formatDateTimeInQuery(['sci.created_at'])}
            FROM scan_charger_invoice sci
            WHERE sci.rider_id = ?
            ORDER BY sci.id DESC
            LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [rider_id]
        );

        const [[{ total }]] = await db.query('SELECT FOUND_ROWS() AS total');
        const totalPage = Math.max(Math.ceil(total / limit), 1);

        return resp.json({
            status  : 1,
            code    : 200,
            message : ["Invoice Data"],
            data    : { invoice_list: invoiceData, total, totalPage },
        });
    } catch (error) {
        console.log('Something went wrong in scanChargeInvoices', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};

/** GET /scan-charge-invoice-detail — Query: rider_id, invoice_id */
export const scanChargeInvoiceDetail = async (req, resp) => {
    try {
        const { rider_id, invoice_id } = mergeParam(req);

        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id   : ["required"],
            invoice_id : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const invoiceData = await queryDB(`
            SELECT
                sci.invoice_id,
                sci.invoice_status,
                sci.resident_name,
                sci.resident_email,
                sci.resident_address,
                sci.no_of_session,
                sci.total_consumption,
                sci.over_time_min,
                sci.per_kwh_charge,
                sci.extra_charge_per_min,
                sci.energy_price_total,
                sci.extra_charge_total,
                sci.subtotal,
                sci.vat,
                sci.total_amount,
                sci.community_name,
                sci.area_name,
                ${formatDateTimeInQuery(['sci.created_at'])}
            FROM scan_charger_invoice sci
            WHERE sci.rider_id = ? AND sci.invoice_id = ?`, [rider_id, invoice_id]
        );

        if (!invoiceData) {
            return resp.json({ message: ["No invoice was found"], status: 0, code: 422, error: true });
        }

        return resp.json({ status: 1, code: 200, message: ["Invoice Data"], data: invoiceData });
    } catch (error) {
        console.log('Something went wrong in scanChargeInvoiceDetail', error);
        tryCatchErrorHandler(req.originalUrl, error, resp);
    }
};
