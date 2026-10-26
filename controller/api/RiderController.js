import moment from "moment";
import crypto from 'crypto';
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import db from "../../config/db.js";
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import generateUniqueId from 'generate-unique-id';
import { insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import { mergeParam, generateRandomPassword, checkNumber, generateOTP, storeOTP, getOTP, delOTP, sendOtp, formatDateTimeInQuery, formatDateInQuery, asyncHandler } from '../../utils.js';
dotenv.config();
import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
import { removeAllCards } from '../PaymentController.js';

// Link admin-created charger installation inquiries to rider when mobile_no matches rider_mobile
const linkChargerInstallationInquiryToRider = async (riderId, riderMobile) => {
    await db.execute(
        `UPDATE charger_installation_inquiry SET rider_id = ? WHERE mobile_no = ? AND rider_id IS NULL`,
        [riderId, riderMobile]
    );
};

const OFFLINE_RIDER_SOURCES = ['Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl'];

const isIncompleteOfflineRider = (rider) => {
    if (!rider) return false;
    const source = String(rider.added_from || '').trim();
    if (!OFFLINE_RIDER_SOURCES.includes(source)) return false;
    // Admin-created riders usually have no access_token until first app login/register.
    return !rider.access_token || Number(rider.status) === 0;
};

const splitCustomerName = (fullName = '') => {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first_name: '', last_name: '' };
    return {
        first_name: parts[0],
        last_name : parts.length > 1 ? parts.slice(1).join(' ') : '',
    };
};

// Link admin offline RSA bookings (and invoice/history) by mobile and/or email.
// On match, set rider_id + overwrite customer_name & emirates from the signup user.
const linkOfflineRsaToRider = async (riderId, riderMobile, riderEmail = null, profile = {}) => {
    const mobile = riderMobile || null;
    const email  = riderEmail || null;
    if (!mobile && !email) return;

    await db.execute(
        `UPDATE rsa_offline_booking
         SET rider_id = ?,
             customer_name = ?,
             emirates = ?,
             email_id = COALESCE(NULLIF(TRIM(email_id), ''), ?),
             mobile_no = COALESCE(NULLIF(TRIM(mobile_no), ''), ?)
         WHERE rider_id IS NULL
           AND (
                (? IS NOT NULL AND mobile_no = ?)
             OR (? IS NOT NULL AND email_id = ?)
           )`,
        [
            riderId,
            profile.customer_name || null,
            profile.emirates || null,
            email,
            mobile,
            mobile, mobile,
            email, email,
        ]
    );

    await db.execute(
        `UPDATE rsa_offline_invoice roi
         INNER JOIN rsa_offline_booking rob ON rob.request_id = roi.request_id
         SET roi.rider_id = ?
         WHERE roi.rider_id IS NULL
           AND (
                (? IS NOT NULL AND rob.mobile_no = ?)
             OR (? IS NOT NULL AND rob.email_id = ?)
             OR rob.rider_id = ?
           )`,
        [riderId, mobile, mobile, email, email, riderId]
    );

    await db.execute(
        `UPDATE rsa_offline_order_history roh
         INNER JOIN rsa_offline_booking rob ON rob.request_id = roh.order_id
         SET roh.rider_id = ?
         WHERE roh.rider_id IS NULL
           AND (
                (? IS NOT NULL AND rob.mobile_no = ?)
             OR (? IS NOT NULL AND rob.email_id = ?)
             OR rob.rider_id = ?
           )`,
        [riderId, mobile, mobile, email, email, riderId]
    );
};

const getOfflineBookingPrefill = async (mobile, email = null) => {
    const booking = await queryDB(
        `SELECT customer_name, mobile_no, email_id, country_code, emirates
         FROM rsa_offline_booking
         WHERE (
                (? IS NOT NULL AND mobile_no = ?)
             OR (? IS NOT NULL AND email_id = ?)
           )
         ORDER BY id DESC
         LIMIT 1`,
        [mobile, mobile, email, email]
    );
    if (!booking) return null;

    const { first_name, last_name } = splitCustomerName(booking.customer_name);
    return {
        first_name,
        last_name,
        rider_email  : booking.email_id || null,
        rider_mobile : booking.mobile_no || mobile || null,
        country_code : booking.country_code || '+971',
        emirates     : booking.emirates || null,
    };
};

const getRiderPrefill = (rider) => {
    if (!rider) return null;
    return {
        first_name   : rider.rider_name || '',
        last_name    : rider.last_name || '',
        rider_email  : rider.rider_email || null,
        rider_mobile : rider.rider_mobile || null,
        country_code : rider.country_code || '+971',
        emirates     : rider.emirates || null,
        rider_id     : rider.rider_id || null,
    };
};
/* Rider Auth */
const resolveAppPlatform = (added_from = '') => {
    return added_from === 'iOS' ? 'iOS' : 'Android';
};

export const login = asyncHandler(async (req, resp) => {
    const { mobile, password ,fcm_token , country_code, added_from = '' } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        mobile: ["required"], password: ["required"], fcm_token: ["required"], country_code: ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const rider = await queryDB(`
        SELECT 
            rider_id, rider_name, rider_email, profile_img, country_code, country, emirates, status, password, rider_mobile
        FROM riders 
        WHERE rider_mobile = ? AND country_code = ? LIMIT 1`,
        [mobile, mobile, country_code]
    );
    if(!rider) return resp.json({ status: 0, code: 422, message: ["The mobile number is not registered with us. Kindly sign up."] });

    const isMatch = await bcrypt.compare(password, rider.password);
    if (!isMatch) return resp.json({ status:0, code:405, error:true, message: ["Password is incorrect"] });

    if (rider.status == 2) return resp.json({ status:0, code:405, error:true, message: ["You can not login as your status is inactive. Kindly contact to customer care"] });
    
    const token    = crypto.randomBytes(12).toString('hex');
    const platform = resolveAppPlatform(added_from);
    const [update] = await db.execute(
        `UPDATE riders
         SET access_token = ?, status = ?, fcm_token = ?,
             added_from = CASE
                 WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl', 'Community' ) THEN ?
                 ELSE added_from
             END
         WHERE rider_mobile = ?`,
        [token, 1, fcm_token, platform, mobile]
    );

    if(update.affectedRows > 0){
        const result = {
            image_url    : `${process.env.DIR_UPLOADS}rider_profile/`,
            rider_id     : rider.rider_id,
            rider_name   : rider.rider_name,
            rider_email  : rider.rider_email,
            profile_img  : rider.profile_img,
            country_code : rider.country_code,
            rider_mobile : rider.rider_mobile,
            country      : rider.country,
            emirates     : rider.emirates,
            access_token : token
        };
        return resp.json({status:1, code:200, message: ["Login successful"], result: result});
    } else {
        return resp.json({status:0, code:405, message: ["Oops! There is something went wrong! Please Try Again"], error: true});
    }
});

export const register1 = asyncHandler(async (req, resp) => {
    const { 
        first_name, last_name, rider_email, country_code, rider_mobile, emirates, added_from, otp, fcm_token =""  
    } = mergeParam(req);
    
    let validationRules = {
        first_name   : ["required"],
        last_name    : ["required"],
        rider_email  : ["required", "email"],
        country_code : ["required"],
        rider_mobile : ["required"],
        emirates     : ["required"],
        otp          : ["required"],
        // fcm_token    : ["required"],
    };
    const { isValid, errors } = validateFields(mergeParam(req), validationRules);
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const res = checkNumber(country_code, rider_mobile);
    if(res.status == 0) return resp.json({ status : 0, code : 422, message : res.msg });

    const fullMobile = `${country_code}${rider_mobile}`;
    const cachedOtp  = getOTP(fullMobile);
    if (!cachedOtp || cachedOtp !== otp) return resp.json({ status: 0, code: 422, message: ["OTP invalid!"] });

    const rider = await insertRecord('riders', 
    [
        'rider_id', 'rider_name', 'last_name', 'rider_email', 'country_code', 'rider_mobile', 'emirates', 'status', 'added_from' 
    ],[ 
        'ER', first_name, last_name, rider_email, country_code, rider_mobile, emirates, 
        0, added_from || 'Android' 
    ]);
    if(!rider) return resp.json({status:0, code:405, message: ["Failed to register. Please Try Again"], error: true}); 

    const riderId = 'ER' + String(rider.insertId).padStart(4, '0');
    const token   = crypto.randomBytes(12).toString('hex');
    const updtObj = {
        rider_id     : riderId,
        access_token : token, 
        status       : 1, 
        fcm_token    : fcm_token
    }
    await updateRecord('riders', updtObj, ['id'], [ rider.insertId ]);

    // Link admin-created offline RSA bookings to this rider when mobile_no matches rider_mobile
    await linkOfflineRsaToRider(riderId, rider_mobile);
    // Link admin-created charger installation inquiries (fail-soft: never block registration)
    try {
        await linkChargerInstallationInquiryToRider(riderId, rider_mobile);
    } catch (linkErr) {
        console.error('[register] charger installation inquiry link skipped:', linkErr.message);
    }

    delOTP(fullMobile);

    // Resident if community_resident row exists (map may be populated by admin after signup)
    const rsidentData = await queryDB(`
        SELECT resident_name
        FROM community_resident
        WHERE resident_mobile = ?`,
        [ rider_mobile ]
    );

    const result = {
        image_url    : `${process.env.DIR_UPLOADS}rider_profile/`,
        rider_id     : riderId,
        rider_name   : first_name,
        last_name    : last_name,
        rider_email  : rider_email,
        profile_img  : null,
        country_code : country_code,
        rider_mobile : rider_mobile,
        emirates     : emirates,
        access_token : token,
        is_resident  : !rsidentData ? 0 : 1,
    };
    return resp.json({ status : 1, code : 200, message : ["Rider registered successfully"], result : result});
});

export const register = asyncHandler(async (req, resp) => {
    console.log('register called')
    const { 
        first_name, last_name, rider_email, country_code, rider_mobile, emirates, added_from, otp, fcm_token =""  
    } = mergeParam(req);
    
    let validationRules = {
        first_name   : ["required"],
        last_name    : ["required"],
        rider_email  : ["required", "email"],
        country_code : ["required"],
        rider_mobile : ["required"],
        emirates     : ["required"],
        otp          : ["required"],
        // fcm_token    : ["required"],
    };
    const { isValid, errors } = validateFields(mergeParam(req), validationRules);
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const res = checkNumber(country_code, rider_mobile);
    if(res.status == 0) return resp.json({ status : 0, code : 422, message : res.msg });

    const fullMobile = `${country_code}${rider_mobile}`;
    const cachedOtp  = getOTP(fullMobile);
    if (!cachedOtp || cachedOtp !== otp) return resp.json({ status: 0, code: 422, message: ["OTP invalid!"] });

    const existingRider = await queryDB(
        `SELECT id, rider_id, rider_email, access_token, status, added_from
         FROM riders
         WHERE rider_mobile = ?
         LIMIT 1`,
        [rider_mobile]
    );

    if (existingRider && !isIncompleteOfflineRider(existingRider)) {
        return resp.json({
            status  : 0,
            code    : 422,
            message : ['The provided number already exists. Please login.'],
        });
    }

    const emailTaken = await queryDB(
        `SELECT rider_id FROM riders
         WHERE rider_email = ? AND rider_id != ?
         LIMIT 1`,
        [rider_email, existingRider?.rider_id || '']
    );
    if (emailTaken?.rider_id) {
        return resp.json({ status: 0, code: 422, message: ['Email already registered.'] });
    }

    const platform = resolveAppPlatform(added_from);
    const token    = crypto.randomBytes(12).toString('hex');
    let riderId;

    if (existingRider && isIncompleteOfflineRider(existingRider)) {
        // Complete admin-created offline rider instead of inserting a duplicate.
        riderId = existingRider.rider_id;
        await updateRecord('riders', {
            rider_name   : first_name,
            last_name    : last_name,
            rider_email  : rider_email,
            country_code : country_code,
            emirates     : emirates,
            access_token : token,
            status       : 1,
            fcm_token    : fcm_token,
            added_from   : platform,
        }, ['id'], [existingRider.id]);
    } else {
        const rider = await insertRecord('riders',
        [
            'rider_id', 'rider_name', 'last_name', 'rider_email', 'country_code', 'rider_mobile', 'emirates', 'status', 'added_from'
        ],[
            'ER', first_name, last_name, rider_email, country_code, rider_mobile, emirates,
            0, platform
        ]);
        if(!rider) return resp.json({status:0, code:405, message: ["Failed to register. Please Try Again"], error: true});

        riderId = 'ER' + String(rider.insertId).padStart(4, '0');
        await updateRecord('riders', {
            rider_id     : riderId,
            access_token : token,
            status       : 1,
            fcm_token    : fcm_token
        }, ['id'], [ rider.insertId ]);
    }

    // If offline booking matches signup mobile OR email, push rider_id / name / emirates onto it.
    try {
        await linkOfflineRsaToRider(riderId, rider_mobile, rider_email, {
            customer_name : `${first_name} ${last_name}`.trim(),
            emirates,
        });
    } catch (linkErr) {
        console.error('[register] offline RSA link skipped:', linkErr.message);
    }

    delOTP(fullMobile);

    // Resident if community_resident row exists (map may be populated by admin after signup)
    const rsidentData = await queryDB(`
        SELECT resident_name
        FROM community_resident
        WHERE resident_mobile = ?`,
        [ rider_mobile ]
    );

    const result = {
        image_url    : `${process.env.DIR_UPLOADS}rider_profile/`,
        rider_id     : riderId,
        rider_name   : first_name,
        last_name    : last_name,
        rider_email  : rider_email,
        profile_img  : null,
        country_code : country_code,
        rider_mobile : rider_mobile,
        emirates     : emirates,
        access_token : token,
        is_resident  : !rsidentData ? 0 : 1,
    };
    return resp.json({ status : 1, code : 200, message : ["Rider registered successfully"], result : result});
});

export const regsCreateOTP1 = asyncHandler(async (req, resp) => {
    const { mobile, country_code, rider_email } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        mobile       : ["required"], 
        country_code : ["required"],
        rider_email  : ["required"]
    });
    if (!isValid) return resp.json({ status : 0, code : 422, message : errors });

    const res = checkNumber(country_code, mobile);
    if(res.status == 0) return resp.json({ status : 0, code : 422, message : res.msg });

    const fullMobile = `${country_code}${mobile}`;
    const [[isExist]] = await db.execute(`
        SELECT rider_mobile, 
            (SELECT COUNT(*) FROM riders AS r WHERE r.rider_email = ?) AS check_email,
            (SELECT COUNT(*) FROM riders AS r1 WHERE r1.rider_mobile = ?) AS check_mob,
            (SELECT COUNT(*) FROM rsa WHERE rsa.mobile = ? ) AS rsa_mob
        FROM 
            riders
        LIMIT 1 `, [rider_email, mobile, fullMobile ]
    );
    if(isExist.check_mob > 0 || isExist.rsa_mob > 0 ) return resp.json({ status:0, code:422, message: ['The provided number already exists.'] });

    if(isExist.check_email > 0 ) return resp.json({ status : 0, code : 422, message : ['Email already registered.'] });

    const otp = generateOTP(4);
    storeOTP(fullMobile, otp);
    return resp.json({ status: 1, code: 200, data: otp, message: ['OTP sent successfully!'] }); //for testing server 

    // sendOtp( fullMobile,
    //     `Your One-Time Password (OTP) for sign-up is: ${otp}. Do not share this OTP with anyone. Thank you for choosing PlusX Electric App!. A6NKWsZKgrz`
    // )
    // .then(result => {
    //     if (result.status === 0) return resp.json(result);
    //     return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
    // })
    // .catch(err => {
    //     tryCatchErrorHandler(req.originalUrl, err, resp, 'Failed to send OTP' );
    // }); 
    
});

export const regsCreateOTP = asyncHandler(async (req, resp) => {
    console.log('regsCreateOTP called')
    const { mobile, country_code, rider_email } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        mobile       : ["required"], 
        country_code : ["required"],
        rider_email  : ["required"]
    });
    if (!isValid) return resp.json({ status : 0, code : 422, message : errors });

    const res = checkNumber(country_code, mobile);
    if(res.status == 0) return resp.json({ status : 0, code : 422, message : res.msg });

    const fullMobile = `${country_code}${mobile}`;

    const existingRider = await queryDB(
        `SELECT rider_id, rider_name, last_name, rider_email, country_code, rider_mobile, emirates,
                access_token, status, added_from
         FROM riders
         WHERE rider_mobile = ?
         LIMIT 1`,
        [mobile]
    );

    const [[rsaRow]] = await db.execute(
        `SELECT COUNT(*) AS rsa_mob FROM rsa WHERE mobile = ?`,
        [fullMobile]
    );
    if (rsaRow.rsa_mob > 0) {
        return resp.json({ status: 0, code: 422, message: ['The provided number already exists.'] });
    }

    if (existingRider && !isIncompleteOfflineRider(existingRider)) {
        return resp.json({
            status  : 0,
            code    : 422,
            message : ['The provided number already exists. Please login.'],
        });
    }

    const emailTaken = await queryDB(
        `SELECT rider_id FROM riders
         WHERE rider_email = ? AND rider_id != ?
         LIMIT 1`,
        [rider_email, existingRider?.rider_id || '']
    );
    if (emailTaken?.rider_id) {
        return resp.json({ status: 0, code: 422, message: ['Email already registered.'] });
    }

    let prefill = getRiderPrefill(existingRider);
    if (!prefill) {
        prefill = await getOfflineBookingPrefill(mobile, rider_email);
    }

    const otp = generateOTP(4);
    storeOTP(fullMobile, otp);
    return resp.json({ status: 1, code: 200, data: otp, message: ['OTP sent successfully!'] }); //for testing server 

    // sendOtp( fullMobile,
    //     `Your One-Time Password (OTP) for sign-up is: ${otp}. Do not share this OTP with anyone. Thank you for choosing PlusX Electric App!. A6NKWsZKgrz`
    // )
    // .then(result => {
    //     if (result.status === 0) return resp.json(result);
    //     return resp.json({
    //         status                   : 1,
    //         code                     : 200,
    //         data                     : '',
    //         message                  : ['OTP sent successfully!'],
    //         can_register             : 1,
    //         incomplete_offline_rider : existingRider && isIncompleteOfflineRider(existingRider) ? 1 : 0,
    //         has_offline_booking      : prefill && !existingRider ? 1 : 0,
    //         prefill                  : prefill || null,
    //     });
    // })
    // .catch(err => {
    //     tryCatchErrorHandler(req.originalUrl, err, resp, 'Failed to send OTP' );
    // }); 
    
});

export const createOTP1 = asyncHandler(async (req, resp) => {
    const { mobile, country_code } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        mobile       : ["required"], 
        country_code : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const res = checkNumber(country_code, mobile);
    if(res.status == 0) return resp.json({ status:0, code:422, message: res.msg });
    
    let checkCountQuery = 'SELECT COUNT(id) AS count FROM riders WHERE rider_mobile =? AND country_code =?';
    
    const [rows]     = await db.execute(checkCountQuery, [mobile, country_code]);
    const checkCount = rows[0].count;
    
    if (checkCount == 0) return resp.json({ status: 0, code: 422, message: ['The provided mobile number is not registered.'] });
    
    const fullMobile = `${country_code}${mobile}`;
    let otp          = ( mobile == 508509508 || mobile == '508509508') ? "2404" : generateOTP(4);
        otp          = ( mobile == 509508509 || mobile == '509508509') ? "2207" : otp;

    storeOTP(fullMobile, otp);
    return resp.json({ status: 1, code: 200, data: otp, message: ['OTP sent successfully!'] }); //this is for testing server

    // if( mobile == 508509508 || mobile == '508509508') {
    //     return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
        
    // } else if( mobile == 509508509 || mobile == '509508509') {
    //     return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
        
    // } else {
    //     sendOtp( fullMobile,
    //         `Your One-Time Password (OTP) for sign-in is: ${otp}. Do not share this OTP with anyone. Thank you for choosing PlusX Electric App!. A6NKWsZKgrz`
    //     )
    //     .then(result => {
    //         if (result.status === 0) return resp.json(result);
    //         return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
    //     })
    //     .catch(err => {
    //         console.error('Error in otpController:', err.message);
    //         return resp.json({ status: 'error', msg: 'Failed to send OTP' });
    //     }); 
    // }
});

export const createOTP = asyncHandler(async (req, resp) => {
    const { mobile, country_code } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        mobile       : ["required"], 
        country_code : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const res = checkNumber(country_code, mobile);
    if(res.status == 0) return resp.json({ status:0, code:422, message: res.msg });
    
    let checkCountQuery = 'SELECT COUNT(id) AS count FROM riders WHERE rider_mobile =? AND country_code =?';
    
    const [rows]     = await db.execute(checkCountQuery, [mobile, country_code]);
    const checkCount = rows[0].count;
    
    if (checkCount == 0) {
        const bookingPrefill = await getOfflineBookingPrefill(mobile);
        return resp.json({
            status              : 0,
            code                : 422,
            message             : ['The provided mobile number is not registered. Kindly sign up.'],
            needs_registration  : 1,
            has_offline_booking : bookingPrefill ? 1 : 0,
            prefill             : bookingPrefill || null,
        });
    }
    
    const fullMobile = `${country_code}${mobile}`;
    let otp          = ( mobile == 508509508 || mobile == '508509508') ? "2404" : generateOTP(4);
        otp          = ( mobile == 509508509 || mobile == '509508509') ? "2207" : otp;

    storeOTP(fullMobile, otp);
    return resp.json({ status: 1, code: 200, data: otp, message: ['OTP sent successfully!'] }); //this is for testing server

    // if( mobile == 508509508 || mobile == '508509508') {
    //     return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
        
    // } else if( mobile == 509508509 || mobile == '509508509') {
    //     return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
        
    // } else {
    //     sendOtp( fullMobile,
    //         `Your One-Time Password (OTP) for sign-in is: ${otp}. Do not share this OTP with anyone. Thank you for choosing PlusX Electric App!. A6NKWsZKgrz`
    //     )
    //     .then(result => {
    //         if (result.status === 0) return resp.json(result);
    //         return resp.json({ status: 1, code: 200, data: '', message: ['OTP sent successfully!'] });
    //     })
    //     .catch(err => {
    //         console.error('Error in otpController:', err.message);
    //         return resp.json({ status: 'error', msg: 'Failed to send OTP' });
    //     }); 
    // }
});

export const verifyOTPOld = asyncHandler(async (req, resp) => {
    const { mobile, country_code, fcm_token, otp, device_name ='', added_from = '' } = mergeParam(req);
    
    const { isValid, errors } = validateFields(mergeParam(req), { 
        mobile       : ["required"], 
        country_code : ["required"], 
        fcm_token    : ["required"], 
        otp          : ["required"] 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    // is_resident > 0 when mapped to any community (multi-community aware)
    const riderData = await queryDB(`
        SELECT
            rider_id, rider_name, last_name, rider_email, profile_img, country, emirates, status,
            ( SELECT CASE
                WHEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? ) > 0
                THEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? )
                WHEN EXISTS ( SELECT 1 FROM community_resident WHERE resident_mobile = ? )
                THEN 1
                ELSE 0
              END
            ) AS resident_count
        FROM riders
        WHERE rider_mobile = ? AND country_code = ?
        LIMIT 1`, [mobile, mobile, mobile, mobile, country_code]
    );

    if(!riderData) return resp.json({ 
        status  : 0, code: 422, 
        message : ["The mobile number is not registered with us. Kindly sign up."] 
    });
    if(riderData.status == 2){
        return resp.json({status: 1, code: 422, message: ["You can not login as your status is inactive. Kindly contact to customer care"]});
    }
    const fullMobile = `${country_code}${mobile}`;
    const cachedOtp  = getOTP(fullMobile);
    
    if (!cachedOtp || cachedOtp !== otp) return resp.json({ status: 0, code: 422, message: ["OTP invalid!"] });

    const token    = crypto.randomBytes(12).toString('hex');
    const platform = resolveAppPlatform(added_from);
    await db.execute(
        `UPDATE riders
         SET access_token = ?, status = 1, fcm_token = ?, device_name = ?,
             added_from = CASE
                 WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl', 'Community' ) THEN ?
                 ELSE added_from
             END
         WHERE rider_mobile = ? AND country_code = ?`,
        [token, fcm_token, device_name, platform, mobile, country_code]
    );

    delOTP(fullMobile);
    let respResult = {
        image_url     : `${process.env.DIR_UPLOADS}rider_profile/`,
        rider_id      : riderData.rider_id,
        rider_name    : riderData.rider_name,
        last_name     : riderData.last_name,
        rider_email   : riderData.rider_email,
        profile_img   : riderData.profile_img,
        rider_mobile  : mobile,
        country_code  : country_code,        
        emirates      : riderData.emirates,
        access_token  : token,
        is_resident   : riderData.resident_count,
    };
    return resp.json({message: [ "Login successful!" ], status: 1, code: 200, is_login: 1, result: respResult});
});

export const verifyOTP1 = asyncHandler(async (req, resp) => {
    const { mobile, country_code, fcm_token, otp, device_name ='', added_from = '' } = mergeParam(req);
    
    const { isValid, errors } = validateFields(mergeParam(req), { 
        mobile       : ["required"], 
        country_code : ["required"], 
        fcm_token    : ["required"], 
        otp          : ["required"] 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    // is_resident > 0 when mapped to any community (multi-community aware)
    const riderData = await queryDB(`
        SELECT
            rider_id, rider_name, last_name, rider_email, profile_img, country, emirates, status,
            ( SELECT CASE
                WHEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? ) > 0
                THEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? )
                WHEN EXISTS ( SELECT 1 FROM community_resident WHERE resident_mobile = ? )
                THEN 1
                ELSE 0
              END
            ) AS resident_count
        FROM riders
        WHERE rider_mobile = ? AND country_code = ?
        LIMIT 1`, [mobile, mobile, mobile, mobile, country_code]
    );

    if(!riderData) return resp.json({ 
        status  : 0, code: 422, 
        message : ["The mobile number is not registered with us. Kindly sign up."] 
    });
    if(riderData.status == 2){
        return resp.json({status: 1, code: 422, message: ["You can not login as your status is inactive. Kindly contact to customer care"]});
    }
    const fullMobile = `${country_code}${mobile}`;
    const cachedOtp  = getOTP(fullMobile);
    
    if (!cachedOtp || cachedOtp !== otp) return resp.json({ status: 0, code: 422, message: ["OTP invalid!"] });

    const token    = crypto.randomBytes(12).toString('hex');
    const platform = resolveAppPlatform(added_from);
    await db.execute(
        `UPDATE riders
         SET access_token = ?, status = 1, fcm_token = ?, device_name = ?,
             added_from = CASE
                 WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl', 'Community' ) THEN ?
                 ELSE added_from
             END
         WHERE rider_mobile = ? AND country_code = ?`,
        [token, fcm_token, device_name, platform, mobile, country_code]
    );

    delOTP(fullMobile);
    let respResult = {
        image_url     : `${process.env.DIR_UPLOADS}rider_profile/`,
        rider_id      : riderData.rider_id,
        rider_name    : riderData.rider_name,
        last_name     : riderData.last_name,
        rider_email   : riderData.rider_email,
        profile_img   : riderData.profile_img,
        rider_mobile  : mobile,
        country_code  : country_code,        
        emirates      : riderData.emirates,
        access_token  : token,
        is_resident   : riderData.resident_count,
    };
    return resp.json({message: [ "Login successful!" ], status: 1, code: 200, is_login: 1, result: respResult});
});

export const verifyOTP = asyncHandler(async (req, resp) => {
    const { mobile, country_code, fcm_token, otp, device_name ='', added_from = '' } = mergeParam(req);
    
    const { isValid, errors } = validateFields(mergeParam(req), { 
        mobile       : ["required"], 
        country_code : ["required"], 
        fcm_token    : ["required"], 
        otp          : ["required"] 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    // is_resident > 0 when mapped to any community (multi-community aware)
    const riderData = await queryDB(`
        SELECT
            rider_id, rider_name, last_name, rider_email, profile_img, country, emirates, status,
            ( SELECT CASE
                WHEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? ) > 0
                THEN ( SELECT COUNT(DISTINCT crm.community_id)
                       FROM community_resident cr
                       INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                       WHERE cr.resident_mobile = ? )
                WHEN EXISTS ( SELECT 1 FROM community_resident WHERE resident_mobile = ? )
                THEN 1
                ELSE 0
              END
            ) AS resident_count
        FROM riders
        WHERE rider_mobile = ? AND country_code = ?
        LIMIT 1`, [mobile, mobile, mobile, mobile, country_code]
    );

    if(!riderData) return resp.json({ 
        status  : 0, code: 422, 
        message : ["The mobile number is not registered with us. Kindly sign up."] 
    });
    if(riderData.status == 2){
        return resp.json({status: 1, code: 422, message: ["You can not login as your status is inactive. Kindly contact to customer care"]});
    }
    const fullMobile = `${country_code}${mobile}`;
    const cachedOtp  = getOTP(fullMobile);
    
    if (!cachedOtp || cachedOtp !== otp) return resp.json({ status: 0, code: 422, message: ["OTP invalid!"] });

    const token    = crypto.randomBytes(12).toString('hex');
    const platform = resolveAppPlatform(added_from);
    await db.execute(
        `UPDATE riders
         SET access_token = ?, status = 1, fcm_token = ?, device_name = ?,
             added_from = CASE
                 WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl', 'Community') THEN ?
                 ELSE added_from
             END
         WHERE rider_mobile = ? AND country_code = ?`,
        [token, fcm_token, device_name, platform, mobile, country_code]
    );

    delOTP(fullMobile);

    try {
        await linkOfflineRsaToRider(
            riderData.rider_id,
            mobile,
            riderData.rider_email,
            {
                customer_name : `${riderData.rider_name || ''} ${riderData.last_name || ''}`.trim(),
                emirates      : riderData.emirates,
            }
        );
    } catch (linkErr) {
        console.error('[verifyOTP] offline RSA link skipped:', linkErr.message);
    }

    let respResult = {
        image_url     : `${process.env.DIR_UPLOADS}rider_profile/`,
        rider_id      : riderData.rider_id,
        rider_name    : riderData.rider_name,
        last_name     : riderData.last_name,
        rider_email   : riderData.rider_email,
        profile_img   : riderData.profile_img,
        rider_mobile  : mobile,
        country_code  : country_code,        
        emirates      : riderData.emirates,
        access_token  : token,
        is_resident   : riderData.resident_count,
    };
    return resp.json({message: [ "Login successful!" ], status: 1, code: 200, is_login: 1, result: respResult});
});

export const forgotPassword = asyncHandler(async (req, resp) => {
    const { email } = mergeParam(req);
    if (!email) return resp.json({ status: 0, code: 405, error: true, message: ['Email is required'] });

    const rider = await queryDB('SELECT rider_name FROM riders WHERE rider_email=?', [email]);
    if( !rider ) {
        return resp.json({status: 0, code: 400, message: 'Oops! Invalid Email Address'});
    }
    const password   = generateRandomPassword(6);
    const hashedPswd = await bcrypt.hash(password, 10);
    await db.execute('UPDATE riders SET password = ? WHERE rider_email = ?', [hashedPswd, email]);
    try {
        const html = `<html>
            <body>
                <h4>Dear ${rider.rider_name},</h4>
                <p>We have generated a new password for you <b>'${password}'</b> Please use this temporary password to log in to your account.</p> 
                <p>Once logged in, we highly recommend that you change your password to something more memorable. You can do this by following these simple steps: </p>
                <p>Log in to your account using the provided temporary password.</p>
                <p>Navigate to the "Profile" section.</p> 
                <p>Look for the "Reset Password" option within the profile settings.</p>                         
                <p>Enter your new password and confirm it.</p> 
                <p>Save the changes.</p> 
                <p>Regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
        emailQueue.addEmail(email, `Forgot Password Request - PlusX Electric App`, html);
    
        return resp.json({ status: 1, code: 200, message: "Password Reset Request! We have sent the new password to your registered email." });
    } catch (error) {
        
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
});

export const logout = asyncHandler(async (req, resp) => {
    const {rider_id} = mergeParam(req);
    if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });
    
    const rider = queryDB(`SELECT EXISTS (SELECT 1 FROM riders WHERE rider_id = ?) AS rider_exists`, [rider_id]);
    if(!rider) return resp.json({status:0, code:400, message: 'Rider ID Invalid!'});

    const update = await updateRecord('riders', { status : 0, access_token : "", fcm_token : ""}, ['rider_id'], [rider_id]);
    
    if(update.affectedRows > 0){
        return resp.json({status: 1, code: 200, message: 'Logged out sucessfully'});
    } else {
        return resp.json({status: 0, code: 405, message: 'Oops! There is something went wrong! Please Try Again'});
    }

});

export const updatePassword = asyncHandler(async (req, resp) => {
    const { rider_id, old_password, new_password, confirm_password} = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], old_password: ["required"], new_password: ["required"], confirm_password: ["required"]
    });

    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    if(new_password != confirm_password) return resp.json({ status: 0, code: 422, message: ['New password and confirm password not matched!'] });
    
    const rider = await queryDB(`SELECT password FROM riders WHERE rider_id=?`, [rider_id]);
    
    const isMatch = await bcrypt.compare(old_password, rider.password);  
    if (!isMatch) return resp.json({ status: 0, code: 422, message: ["Please enter correct current password."] });

    const hashedPswd = await bcrypt.hash(new_password, 10);
    const update = await updateRecord('riders', {password: hashedPswd}, ['rider_id'], [rider_id]);

    return resp.json({
        status  : update.affectedRows > 0 ? 1 : 0, 
        code    : update.affectedRows > 0 ? 200 : 422, 
        message : update.affectedRows > 0 ? ['Password changed successfully'] : ['Failed to updated password. Please Try Again']
    });
});

/* Rider Info */
export const homeOld = asyncHandler(async (req, resp) => {
    const {rider_id} = mergeParam(req);
    if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });
    
    const riderQuery = `SELECT rider_id, rider_name,
        (SELECT COUNT(*) FROM notifications AS n WHERE n.panel_to = 'Rider' AND n.receive_id = rider_id AND status = '0') AS notification_count,
        ( SELECT CASE
            WHEN ( SELECT COUNT(DISTINCT crm.community_id)
                   FROM community_resident cr
                   INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                   WHERE cr.resident_mobile = riders.rider_mobile ) > 0
            THEN ( SELECT COUNT(DISTINCT crm.community_id)
                   FROM community_resident cr
                   INNER JOIN community_resident_map crm ON crm.resident_id = cr.resident_id
                   WHERE cr.resident_mobile = riders.rider_mobile )
            WHEN EXISTS ( SELECT 1 FROM community_resident cr2 WHERE cr2.resident_mobile = riders.rider_mobile )
            THEN 1
            ELSE 0
          END
        ) AS resident_count,
        (SELECT COUNT(*) FROM purchase_history AS pu WHERE pu.customer_mobile = riders.rider_mobile ) AS purchase_history_count,
        (SELECT COUNT(*) FROM charge_share AS cs WHERE cs.rider_id = ? AND cs.charger_status = 1) AS charge_share_count
        FROM riders WHERE rider_id = ?
    `;
    const riderData = await queryDB(riderQuery, [rider_id, rider_id]);

    if (!riderData) {
        return resp.status(404).json({ message: "Rider not found", status: 0 });
    }
    const result = {
        rider_id               : riderData.rider_id,
        rider_name             : riderData.rider_name,
        notification_count     : riderData.notification_count,
        is_resident            : riderData.resident_count,
        purchase_history_count : riderData.purchase_history_count,
        charge_share_count     : riderData.charge_share_count
    };
    const orderData = await queryDB(
        `SELECT request_id, (SELECT CONCAT(rsa_name, ',', country_code, ' ', mobile) FROM rsa WHERE rsa_id = road_assistance.rsa_id) AS rsaDetails, created_at 
        FROM road_assistance 
        WHERE rider_id = ? AND order_status NOT IN ('PNR', 'CNF', 'A', 'PU', 'C', 'RO', 'CC') 
        ORDER BY id DESC LIMIT 1 `, [rider_id]
    );
    if (orderData) orderData.eta_time = '12 Min.';
    
    const pickDropData = await queryDB(
        `SELECT request_id, (SELECT CONCAT(rsa_name, ',', country_code, ' ', mobile) FROM rsa WHERE rsa_id = charging_service.rsa_id) AS rsaDetails, created_at 
        FROM charging_service 
        WHERE rider_id = ? AND order_status NOT IN ('CNF', 'A', 'WC', 'C', 'PNR', 'DO') 
        ORDER BY id DESC LIMIT 1 `, [rider_id]
    );
    
    if (pickDropData) pickDropData.eta_time = '11 Min.';
    
    const podBookingData = await queryDB(
        `SELECT booking_id AS request_id, (SELECT CONCAT(rsa_name, ',', country_code, ' ', mobile) FROM rsa WHERE rsa_id = portable_charger_booking.rsa_id) AS rsaDetails, created_at 
        FROM portable_charger_booking 
        WHERE rider_id = ? AND status NOT IN ('PNR', 'CNF', 'A', 'PU', 'C', 'RO', 'CC') 
        ORDER BY id DESC LIMIT 1
    `, [rider_id]);

    if (podBookingData) podBookingData.eta_time = '11 Min.';
    
    const currDate = moment().utcOffset(4).format('dddd');
    const currTime = moment().utcOffset(4).format('HH:mm:ss');
    const priceQry  = `
        SELECT 
            portable_price, portable_original_price, pick_drop_price, 
            ( SELECT slot_price FROM road_assistance_slot WHERE status = 1 AND slot_date = "${currDate}" AND "${currTime}" BETWEEN start_time AND end_time order by start_time asc limit 1 ) as slot_price 
        FROM booking_price 
        LIMIT 1`;
    const priceData = await queryDB(priceQry, []);
    const scanChargingData = await scanChargingDetail(rider_id) ;

    const portablePrice = priceData.portable_price;
    const portableOriginalPrice = priceData.portable_original_price ?? null;
    const portableDiscountAmount =
        portableOriginalPrice != null && Number(portableOriginalPrice) > Number(portablePrice)
            ? Number((Number(portableOriginalPrice) - Number(portablePrice)).toFixed(2))
            : null;

    const chargingPackageData = [
        {
            charging_package_name: 'Mobile & Portable\nEV Charging',
            sessions_validity: "2027-01-12",
            total_charging_sessions: 60,
            used_charging_sessions: 12,
            remaining_charging_sessions: 48,
        }, {
            charging_package_name: 'EV Roadside\nAssistance',
            sessions_validity: "2027-01-12",
            total_charging_sessions: 10,
            used_charging_sessions: 2,
            remaining_charging_sessions: 8,
        },
    ];

    return resp.json({
        message                   : ["Rider Home Data fetched successfully!"],
        rider_data                : result,
        order_data                : orderData || null,
        pick_drop_order           : pickDropData || null,
        pod_booking               : podBookingData || null,
        roadside_assistance_price : priceData.slot_price || 0,
        portable_price            : portablePrice,
        portable_original_price   : portableOriginalPrice, // striked display price
        portable_discount_amount  : portableDiscountAmount, // discount amount
        pick_drop_price           : priceData.pick_drop_price,
        status                    : 1,
        code                      : 200,
        scanChargingData,
        chargingPackageData
    });
});

export const home = asyncHandler(async (req, resp) => {
    const {rider_id} = mergeParam(req);
    if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });
    
    const riderQuery = `
        SELECT
            r.rider_id, r.rider_name, r.rider_mobile,
            (
                SELECT COUNT(*)
                FROM notifications n
                WHERE n.panel_to = 'Rider' AND n.receive_id = r.rider_id AND n.status = '0'
            ) AS notification_count,
            (
                SELECT COUNT(*)
                FROM community_resident cr
                WHERE cr.resident_mobile = r.rider_mobile
            ) AS resident_count,
            (
                SELECT COUNT(*)
                FROM purchase_history pu
                WHERE pu.customer_mobile = r.rider_mobile
            ) AS purchase_history_count,
            (
                SELECT COUNT(*)
                FROM charge_share cs
                WHERE cs.rider_id = r.rider_id AND cs.charger_status = 1
            ) AS charge_share_count
        FROM riders r
        WHERE r.rider_id = ?
        LIMIT 1
    `;
    const riderData = await queryDB(riderQuery, [rider_id]);

    if (!riderData) return resp.json({ message: "Rider not found", status: 0 });

    const result = {
        rider_id               : riderData.rider_id,
        rider_name             : riderData.rider_name,
        notification_count     : riderData.notification_count,
        is_resident            : riderData.resident_count,
        purchase_history_count : riderData.purchase_history_count,
        charge_share_count     : riderData.charge_share_count,
    };
    // 2. Calculate UAE current day and time once.
    const now      = moment().utcOffset("+04:00");
    const currDate = now.format("dddd");
    const currTime = now.format("HH:mm:ss");
    const rider_mobile = riderData.rider_mobile;

    const [ orderData, pickDropData, podBookingData, priceData, scanChargingData, packageCountObj ] = await Promise.all([
        // Road assistance
        queryDB( `
            SELECT
                ra.request_id, ra.created_at,
                (
                    SELECT CONCAT( rsa_name, ',', country_code, ' ', mobile )
                    FROM rsa
                    WHERE rsa_id = ra.rsa_id
                ) AS rsaDetails
            FROM road_assistance ra
            WHERE ra.rider_id = ? AND ra.order_status NOT IN ( 'PNR', 'CNF', 'A', 'PU', 'C', 'RO', 'CC' )
            ORDER BY ra.id DESC
            LIMIT 1 `,[rider_id]
        ),
        // Pick and drop / charging service
        queryDB(`
            SELECT
                cs.request_id, cs.created_at,
                (
                    SELECT CONCAT( rsa_name, ',', country_code, ' ', mobile )
                    FROM rsa
                    WHERE rsa_id = cs.rsa_id
                ) AS rsaDetails
            FROM charging_service cs
            WHERE cs.rider_id = ? AND cs.order_status NOT IN ( 'CNF', 'A', 'WC', 'C', 'PNR', 'DO' )
            ORDER BY cs.id DESC
            LIMIT 1 `, [rider_id]
        ),
        // Portable charger booking
        queryDB(`
            SELECT
                pcb.booking_id AS request_id, pcb.created_at,
                (
                    SELECT CONCAT( rsa_name, ',', country_code, ' ', mobile )
                    FROM rsa
                    WHERE rsa_id = pcb.rsa_id
                ) AS rsaDetails
            FROM portable_charger_booking pcb
            WHERE pcb.rider_id = ? AND pcb.status NOT IN ( 'PNR', 'CNF', 'A', 'PU', 'C', 'RO', 'CC' )
            ORDER BY pcb.id DESC
            LIMIT 1 `, [rider_id]
        ),
        // Booking prices
        queryDB(`
            SELECT
                bp.portable_price,
                bp.pick_drop_price,
                (
                    SELECT ras.slot_price
                    FROM road_assistance_slot ras
                    WHERE ras.status = 1 AND ras.slot_date = ? AND ? BETWEEN ras.start_time AND ras.end_time
                    ORDER BY ras.start_time ASC
                    LIMIT 1
                ) AS slot_price
            FROM booking_price bp
            LIMIT 1 `, [ currDate, currTime ]
        ),
        // Scan charging details
        scanChargingDetail(rider_id),
        // package count
        queryDB(`
            SELECT count(*) as packageCount   
            FROM vendor_customers
            WHERE mobile_number = ? `, [ rider_mobile ]
        )
    ]);

    // 4. Assign ETA values without repeating conditions.
    if (orderData) {
        orderData.eta_time = "12 Min.";
    }
    if (pickDropData) {
        pickDropData.eta_time = "11 Min.";
    }
    if (podBookingData) {
        podBookingData.eta_time = "11 Min.";
    }

    
    const packagedata = await queryDB(`
        SELECT 
            vc.customer_id, vc.pod_charging_session_number, vc.pod_charging_session_validity,
            vc.rsa_charging_session_number, vc.rsa_charging_session_validity,
            vc.package_data, vc.purchase_date,
            (
                SELECT count(*)
                FROM portable_charger_booking as pcb
                WHERE DATE(pcb.created_at) >= purchase_date AND DATE(pcb.created_at) <= pod_charging_session_validity AND pcb.status NOT IN ('C')
                AND JSON_UNQUOTE(JSON_EXTRACT(pcb.package_data, '$.package_id')) = vc.customer_id
                AND pcb.rider_id = ? 
            ) as sessionBooking,
            (
                SELECT count(*)
                FROM road_assistance as rs
                WHERE DATE(rs.created_at) >= vc.purchase_date AND DATE(rs.created_at) <= vc.rsa_charging_session_validity AND rs.order_status NOT IN ('C')
                AND rs.rider_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(rs.package_data, '$.customer_id')) = vc.customer_id
            ) as rsaSessionBooking
        FROM vendor_customers vc
        WHERE vc.mobile_number = ?
        ORDER BY id DESC LIMIT 1 `, [ rider_id, rider_id, rider_mobile ]
    );
    const chargingPackageData = [];
    if(packagedata) {
        if(packagedata.pod_charging_session_number) { 

            const sessionBooking    = packagedata.sessionBooking;
            const allotedSession    = packagedata.pod_charging_session_number
            const remainingSessions = allotedSession - sessionBooking

            if(remainingSessions > 0) {
                chargingPackageData.push({
                    charging_package_name       : 'Mobile EV Charging',
                    sessions_validity           : packagedata.pod_charging_session_validity,
                    total_charging_sessions     : allotedSession,
                    used_charging_sessions      : sessionBooking,
                    remaining_charging_sessions : remainingSessions,
                    package_id                  : packagedata.package_data.package_id,
                    charging_capacity           : packagedata.package_data.charging_capacity
                });
            }
        }
        if(packagedata.rsa_charging_session_number) { 
            
            const sessionBooking    = packagedata.rsaSessionBooking;
            const allotedSession    = packagedata.rsa_charging_session_number
            const remainingSessions = allotedSession - sessionBooking
            
            if(remainingSessions > 0) {
                chargingPackageData.push({
                    charging_package_name       : 'Roadside Assistance Service',
                    sessions_validity           : packagedata.rsa_charging_session_validity,
                    total_charging_sessions     : allotedSession,
                    used_charging_sessions      : sessionBooking,
                    remaining_charging_sessions : remainingSessions,
                });
            }
        }
    }
    return resp.json({
        message                   : ["Rider Home Data fetched successfully!"],
        rider_data                : result,
        order_data                : orderData || null,
        pick_drop_order           : pickDropData || null,
        pod_booking               : podBookingData || null,
        roadside_assistance_price : priceData.slot_price || 0,
        portable_price            : priceData.portable_price,
        pick_drop_price           : priceData.pick_drop_price,
        status                    : 1,
        code                      : 200,
        scanChargingData    : scanChargingData,
        chargingPackageData : chargingPackageData,
        packageCount        : packageCountObj.packageCount
    });
});

export const getRiderData = asyncHandler(async(req, resp) => {
    const {rider_id} = mergeParam(req);
    if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });
    
    const rider = await queryDB(`
        SELECT 
            *, ${formatDateTimeInQuery(['created_at', 'updated_at'])}, ${formatDateInQuery(['date_of_birth'])},
            (SELECT COUNT(*) FROM purchase_history AS pu WHERE pu.customer_mobile = riders.rider_mobile ) AS purchase_history_count,
            (SELECT COUNT(*) FROM charge_share AS cs WHERE cs.rider_id = ? AND cs.charger_status = 1) AS charge_share_count
        FROM riders
        WHERE rider_id = ?`, [rider_id, rider_id]
    );
    rider.image_url = `${process.env.DIR_UPLOADS}rider_profile/`;

    return resp.json({
        status  : 1, 
        code    : 200, 
        message : ['Rider Data fetch successfully!'], 
        data    : rider, 
    });
});

export const updateProfile = asyncHandler(async (req, resp) => {
    try {
        let profile_image = '';
        if(req.files && req.files['profile_image']) { 
            const files   = req.files;
            profile_image = files ? files['profile_image'][0].filename : '';
        }
        const { rider_id, first_name, last_name, rider_email, country_code, rider_mobile, emirates} = mergeParam(req);
        const riderId = rider_id;
        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id     : ["required"], 
            first_name   : ["required"], 
            last_name    : ["required"], 
            rider_email  : ["required"], 
            country_code : ["required"], 
            rider_mobile : ["required"], 
            emirates     : ["required"]
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const rider = await queryDB(`SELECT profile_img FROM riders WHERE rider_id=?`, [riderId]);

        const insert = await insertRecord('profile_history', 
            [ 'user_id', 'panel', 'image', 'action' ],
            [ rider_id, 'user', rider.profile_img, 'profile updated' ]
        );
        if( insert.affectedRows == 0 ){ 
            return resp.json({ status: 0, code: 400, message: ['Rider profile was not updated!'] });
        }
        const updates = {
            rider_name : first_name, 
            last_name, 
            rider_email, 
            emirates, 
            profile_img : profile_image
        };
        await updateRecord('riders', updates, ['rider_id'], [riderId]);
        
        return resp.json({status: 1, code: 200, message: ["Rider profile updated successfully"]});
    } catch(err) {
         
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }
});

export const deleteImg = asyncHandler(async (req, resp) => {
    const {rider_id} = mergeParam(req);
    if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });
    
    const rider = await queryDB(`SELECT profile_img FROM riders WHERE rider_id = ?`, [rider_id]);
    if(!rider) return resp.json({status:0, code:400, message: 'Rider ID Invalid!'});
    
    const insert = await insertRecord('profile_history', 
        [ 'user_id', 'panel', 'image', 'action' ],
        [ rider_id, 'user', rider.profile_img, 'profile image deleted' ]
    );
    if( insert.affectedRows == 0 ){ 
        return resp.json({ status: 0, code: 400, message: ['Rider profile image was not deleted!'] });
    }
    const update = await updateRecord('riders', {profile_img: ''}, ['rider_id'], [rider_id]);
    return resp.json({
        status  : update.affectedRows > 0 ? 1 : 0,
        code    : 200,
        message : update.affectedRows > 0 ? ['Rider profile image deleted successfully!'] : ['Oops! Something went wrong. Please try again.'],
    });
});
 
export const deleteAccount = asyncHandler(async (req, resp) => {
    const {rider_id} = mergeParam(req);
    const riderId    = rider_id;
    if (!riderId) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"] });

    try {       
        const rider = await queryDB('SELECT profile_img, rider_name, last_name, rider_email, country_code, rider_mobile, emirates, area, country, date_of_birth, added_from FROM riders WHERE rider_id = ?', [riderId]);
        if(!rider) return resp.json({status:0, message: 'Rider not found.'});
         
        const deleteQueries = [ 'DELETE FROM riders WHERE rider_id = ?' ];
        for (const query of deleteQueries) {
            await db.execute(query, [rider_id]);
        }
        await insertRecord('deleted_riders', [
            'rider_id', 'rider_name', 'last_name', 'rider_email', 'country_code', 'rider_mobile', 'emirates', 'area', 'country', 'profile_img', 'date_of_birth', 'added_from' 
        ],[
            riderId, rider.rider_name, rider.last_name, rider.rider_email, rider.country_code, rider.rider_mobile,  rider.emirates, rider.area, rider.country, rider.profile_img, rider.date_of_birth, rider.added_from 
        ]);
        await removeAllCards(rider.rider_email);

        return resp.json({status: 1, code: 200, error: false, message: ['Rider Account deleted successfully!']});
    } catch(err) {
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }  
});

export const locationList = asyncHandler(async (req, resp) => {
    const [list] = await db.execute(`SELECT location_id, location_name, latitude, longitude, plat_code as emirates_code FROM locations ORDER BY location_name ASC`);
    return resp.json({status: 1, code: 200, message: '', data: list});
});

export const locationAdd = asyncHandler(async (req, resp) => {
    const { location_name, latitude, longitude, status } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), { location_name: ["required"], latitude: ["required"], longitude: ["required"], status: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    if (![1, 2].includes(status)) return resp.json({status:0, code:422, message:"Status should be 1 or 2"});

    const {last_index} = await queryDB(`SELECT MAX(id) AS last_index FROM locations`);
    const nextId       = (!last_index) ? 0 : last_index + 1;
    const locId        = 'Loc' + String(nextId).padStart(4, '0');

    const insert = await insertRecord('locations', ['location_id', 'location_name', 'latitude', 'longitude', 'status'], [locId, location_name, latitude, longitude, status]);

    return resp.json({
        message: insert.affectedRows > 0 ? ['Location added successfully!'] : ['Oops! Something went wrong. Please try again.'],
        status: insert.affectedRows > 0 ? 1 : 0,
        code: 200,
    });
});

export const notificationList = asyncHandler(async (req, resp) => {
    const { rider_id, page_no} = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], page_no: ["required"],
    });

    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit = 10;
    const start = parseInt((page_no * limit) - limit, 10);

    const totalRows = await queryDB(`SELECT COUNT(*) AS total FROM notifications WHERE panel_to = ? AND receive_id = ?`, ['Rider', rider_id]);
    const total_page = Math.ceil(totalRows.total / limit) || 1; 
    
    const [rows] = await db.execute(`SELECT id, heading, description, module_name, panel_to, panel_from, receive_id, status, ${formatDateTimeInQuery(['created_at'])}, href_url
        FROM notifications WHERE panel_to = 'Rider' AND receive_id = ? ORDER BY id DESC LIMIT ${start}, ${parseInt(limit)} 
    `, [rider_id]);
    
    const notifications = rows;
    
    await db.execute(`UPDATE notifications SET status=? WHERE status=? AND panel_to=? AND receive_id=?`, ['1', '0', 'Rider', rider_id]);
    
    return resp.json({status:1, code: 200, message: "Notification list fetch successfully", data: notifications, total_page: total_page, totalRows: totalRows.total});
});

/* Rider Address */
export const riderAddressList = asyncHandler(async (req, resp) => {
    try{
        const { rider_id, address_type, booking_for, emirate } = mergeParam(req);

        let query = `SELECT *, ${formatDateTimeInQuery(['created_at', 'updated_at'])} FROM rider_address WHERE rider_id = ?`;
        let queryParams = [rider_id];
        
        if(emirate && emirate.trim() && emirate.toLowerCase() == 'dubai'){
            query += ` AND emirate = '${emirate}'`;
        }
        if (address_type) {
            const types = address_type.split(",").map(type => type.trim());
            if (types.length > 0) {
                query += ` AND nick_name IN (${types.map(() => '?').join(', ')})`;
                queryParams.push(...types);
            }
        }
        if (booking_for) {
             
            const types = booking_for.split(",").map(type => type.trim());
            if (types.length > 0) {
                query += ` AND booking_for IN (${types.map(() => '?').join(', ')})`;
                queryParams.push(...types);
            } 
        }
        query += ` ORDER BY id DESC`;
        const [result] = await db.execute(query, queryParams);
        return resp.json({message: ['We apologize! Our services are currently unavailable in JLT'], status: 1, code: 200, data: result});
    } catch(err) {
        console.error('Error fetching rider addresses:', err);
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }
});

export const addRiderAddress = asyncHandler(async (req, resp) => {

    const { rider_id, building_name, flat_no, street_name='', landmark, emirates, nick_name, latitude, longitude, booking_for, area } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id      : ["required"], 
        building_name : ["required"], 
        flat_no       : ["required"], 
        landmark      : ["required"], 
        emirates      : ["required"],
        nick_name     : ["required"],  
        latitude      : ["required"], 
        longitude     : ["required"],
        booking_for   : ["required"],
        area          : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const last      = await queryDB(`SELECT id FROM rider_address ORDER BY id DESC LIMIT 1`);

    const start     = last ? last.id : 0;
    const nextId    = start + 1;
    const addressId = 'ADDR' + String(nextId).padStart(4, '0');

    await updateRecord('rider_address', {default_add : 0}, ['rider_id' ], [rider_id ]);
    const default_add = 1;

    const insert = await insertRecord('rider_address', [
        'address_id', 'rider_id', 'building_name', 'unit_no', 'street_name', 'landmark', 'emirate', 'nick_name',  'latitude', 'longitude', 'booking_for', 'area', 'default_add' 
    ],[
        addressId, rider_id, building_name, flat_no, street_name, landmark, emirates, nick_name, latitude, longitude, booking_for, area, default_add
    ]);
    return resp.json({
        message: insert.affectedRows > 0 ? ['Address added successfully!'] : ['Oops! Something went wrong. Please try again.'],
        status: insert.affectedRows > 0 ? 1 : 0
    });
    
});

export const editRiderAddress = asyncHandler(async (req, resp) => {

    const { rider_id, address_id, building_name, flat_no, street_name='', landmark, emirates, nick_name, latitude, longitude, booking_for='', area } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id      : ["required"], 
        address_id    : ["required"], 
        building_name : ["required"], 
        flat_no       : ["required"], 
        landmark      : ["required"], 
        emirates      : ["required"],
        nick_name     : ["required"],  
        latitude      : ["required"], 
        longitude     : ["required"], 
        area          : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const [insret_data] = await db.execute(`
        INSERT INTO rider_address_history (
            address_id, rider_id, emirate, area, building_name, unit_no, street_name,
            landmark, latitude, longitude, nick_name, booking_for, default_add, action
        )
        SELECT 
            address_id, rider_id, emirate, area, building_name, unit_no, street_name,
            landmark, latitude, longitude, nick_name, booking_for, default_add, 'edited'
        FROM 
            rider_address
        WHERE 
            rider_id = ? AND address_id = ?
        `, 
    [rider_id, address_id]);
 
    if(!insret_data.affectedRows ===0) {
        return resp.json({ status : 0, code : 400, message : ['Rider Address was not updated !'] });
    }
    const updates = {building_name, unit_no : flat_no, street_name, landmark, emirate : emirates, nick_name, latitude, longitude, booking_for, area };

    const update = await updateRecord('rider_address', updates, ['rider_id', 'address_id'], [rider_id, address_id]);
    return resp.json({
        status  : update.affectedRows > 0 ? 1 : 0,
        code    : 200,
        message : update.affectedRows > 0 ? ['Rider Address updated successfully!'] : ['Oops! Something went wrong. Please try again.'],
    }); 
});

export const deleteRiderAddress = asyncHandler(async (req, resp) => {
    try{
        const {rider_id, address_id} = mergeParam(req);
        
        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id: ["required"], address_id: ["required"]
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors }); 

        const [insert_data] = await db.execute(`
            INSERT INTO rider_address_history (
                address_id, rider_id, emirate, area, building_name, unit_no, street_name,
                landmark, latitude, longitude, nick_name, booking_for, default_add, action
            )
            SELECT 
                address_id, rider_id, emirate, area, building_name, unit_no, street_name,
                landmark, latitude, longitude, nick_name, booking_for, default_add, 'deleted'
            FROM 
                rider_address
            WHERE 
                rider_id = ? AND address_id = ?
        `, [rider_id, address_id]);
 
        if ( insert_data.affectedRows === 0 ) {
            return resp.json({ message: [' Address was not deleted ! '], status: 0, code: 400 });
        }
        const [del] = await db.execute(`DELETE FROM rider_address WHERE rider_id=? AND address_id=?`,[rider_id, address_id]);
        
        return resp.json({
            message: del.affectedRows > 0 ? ['Address deleted successfully!'] : ['Oops! Something went wrong. Please try again.'],
            status: del.affectedRows > 0 ? 1 : 0
        });
    } catch(err) {
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }
});

/* Rider Vehicle  */
export const riderVehicleList = asyncHandler(async (req, resp) => {
    try{
        const { rider_id, vehicle_type  } = mergeParam(req);
        if (!rider_id) return resp.json({ status: 0, code: 422, message: ["Rider Id is required"]});
        
        let query = ` SELECT vehicle_id, vehicle_type, vehicle_number as plate_number, vehicle_code as plate_code, vehicle_model, vehicle_make as vehicle_brand, vehicle_specification, emirates, default_vehicle FROM riders_vehicles WHERE rider_id = ? `;
        let queryParams = [rider_id];
    
        if (vehicle_type && vehicle_type.trim() !== '') {
            query += ' AND vehicle_type = ?';
            queryParams.push(vehicle_type);
        }
        query += ` ORDER BY id DESC`;
        const [result] = await db.execute(query, queryParams);
        return resp.json({status: 1, code: 200, message: 'List fecth', data: result});
    } catch(err) {
        console.error('Error fetching rider vehicles:', err);
        tryCatchErrorHandler(req.originalUrl, err, resp );
    }
});

export const addRiderVehicle = asyncHandler(async (req, resp) => {
    const {rider_id, vehicle_type, vehicle_brand, vehicle_model, vehicle_specification, emirates, plate_code, plate_number } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id              : ["required"], 
        vehicle_type          : ["required"], 
        vehicle_brand         : ["required"], 
        vehicle_model         : ["required"], 
        vehicle_specification : ["required"], 
        emirates              : ["required"],
        plate_code            : ["required"], 
        plate_number          : ["required"], 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors }); 
    
    await updateRecord('riders_vehicles', {default_vehicle : 0 }, ['rider_id' ], [rider_id ]);

    const insert = await insertRecord('riders_vehicles', [
        'vehicle_id', 'rider_id', 'vehicle_type', 'vehicle_make', 'vehicle_model', 'vehicle_specification', 'emirates', 'vehicle_code', 'vehicle_number', 'default_vehicle' 
    ],[
        'RDV'+generateUniqueId({length:13}), rider_id, vehicle_type, vehicle_brand, vehicle_model, vehicle_specification, emirates, plate_code, plate_number, 1 
    ]);
    return resp.json({
        status: insert.affectedRows > 0 ? 1 : 0,
        code: 200,
        message: insert.affectedRows > 0 ? ['Rider vehicle added successfully!'] : ['Oops! Something went wrong. Please try again.'],
    }); 
});

export const editRiderVehicle = asyncHandler(async (req, resp) => {

    const {rider_id, vehicle_id, vehicle_type, vehicle_brand, vehicle_model, vehicle_specification, emirates, plate_code, plate_number } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id              : ["required"], 
        vehicle_id            : ["required"], 
        vehicle_type          : ["required"], 
        vehicle_brand         : ["required"], 
        vehicle_model         : ["required"], 
        vehicle_specification : ["required"], 
        emirates              : ["required"],
        plate_code            : ["required"], 
        plate_number          : ["required"], 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors }); 
    
    const [insert_data]=await db.execute(`
        INSERT INTO riders_vehicles_history (
            vehicle_id, rider_id, vehicle_type, vehicle_number, vehicle_code,
            vehicle_model, vehicle_make, vehicle_specification, emirates, default_vehicle, action
        )
        SELECT 
            vehicle_id, rider_id, vehicle_type, vehicle_number, vehicle_code,
            vehicle_model, vehicle_make, vehicle_specification , emirates, default_vehicle, 'edited'
        FROM 
            riders_vehicles
        WHERE 
            rider_id = ? AND vehicle_id = ?
        `, [rider_id, vehicle_id]);
    if (insert_data.affectedRows===0){
        return resp.json({ status: 0, code: 400, message: ['Rider vehicle Was not updated! ']  })
    } 

    const updates = {vehicle_type, vehicle_make : vehicle_brand, vehicle_model, vehicle_specification, emirates, vehicle_code : plate_code, vehicle_number : plate_number };

    const update = await updateRecord('riders_vehicles', updates, ['rider_id', 'vehicle_id'], [rider_id, vehicle_id]);

    return resp.json({
        status: update.affectedRows > 0 ? 1 : 0,
        code: 200,
        message: update.affectedRows > 0 ? ['Rider vehicle updated successfully!'] : ['Oops! Something went wrong. Please try again.'],
    }); 
});

export const deleteRiderVehicle = asyncHandler(async (req, resp) => {
    const {rider_id, vehicle_id} = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id   : ["required"], 
        vehicle_id : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors }); 
    
    const [insert_data] = await db.execute(`
        INSERT INTO riders_vehicles_history (
            vehicle_id, rider_id, vehicle_type, vehicle_number, vehicle_code,
            vehicle_model, vehicle_make, vehicle_specification, emirates, default_vehicle, action
        )
        SELECT 
            vehicle_id, rider_id, vehicle_type, vehicle_number, vehicle_code,
            vehicle_model, vehicle_make, vehicle_specification , emirates, default_vehicle, 'deleted'
        FROM 
            riders_vehicles
        WHERE 
            rider_id = ? AND vehicle_id = ? `,  [ rider_id, vehicle_id ]
    );
    if ( insert_data.affectedRows === 0 ) { 
        return resp.json({ status: 0, code: 400, message: ['Rider vehicle was not deleted ']  })
    }
    const [del] = await db.execute(`DELETE FROM riders_vehicles WHERE rider_id=? AND vehicle_id=?`,[rider_id, vehicle_id]);
        
    return resp.json({
        message : del.affectedRows > 0 ? ['Rider vehicle deleted successfully!'] : ['Oops! Something went wrong. Please try again.'],
        status : del.affectedRows > 0 ? 1 : 0,
        code   : 200
    });
});

export const defaultAddress = asyncHandler(async (req, resp) => {

    const { rider_id, address_id, default_address } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id        : ["required"], 
        address_id      : ["required"], 
        default_address : ["required"], 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    await updateRecord('rider_address', {default_add : 0}, ['rider_id' ], [rider_id ]);

    const updates = { default_add : 1 };
    const update  = await updateRecord('rider_address', updates, ['rider_id', 'address_id'], [rider_id, address_id]);
    return resp.json({
        status  : update.affectedRows > 0 ? 1 : 0,
        code    : 200,
        message : update.affectedRows > 0 ? ['Default Address set successfully!'] : ['Oops! Something went wrong. Please try again.'],
    }); 
    
});

export const defaultVehicle = asyncHandler(async (req, resp) => {
    
    const {rider_id, vehicle_id, default_vehicle } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id        : ["required"], 
        vehicle_id      : ["required"], 
        default_vehicle : ["required"], 
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors }); 
    
    await updateRecord('riders_vehicles', {default_vehicle : 0 }, ['rider_id' ], [rider_id ]);

    const updates = {default_vehicle : 1 };
    const update  = await updateRecord('riders_vehicles', updates, ['rider_id', 'vehicle_id'], [rider_id, vehicle_id]);

    return resp.json({
        status  : update.affectedRows > 0 ? 1 : 0,
        code    : 200,
        message : update.affectedRows > 0 ? ['Rider vehicle updated successfully!'] : ['Oops! Something went wrong. Please try again.'],
    }); 
});

const scanChargingDetail = async (rider_id) => {
    try {
        const chargingData = await queryDB(`
            SELECT booking_id, start_time, start_kwh, charger_id, resident_data
            FROM scan_charger_booking
            WHERE rider_id = ? AND status = ?
            ORDER BY id DESC
            LIMIT 1 `, [ rider_id, "S" ]
        );
        if(!chargingData) return null;  
        
        const chargeData = await queryDB(`
            SELECT energy, power
            FROM community_chargers
            WHERE charger_id = ?
            LIMIT 1 `, [ chargingData.charger_id]
        );
        const currentReading  = chargeData?.energy || 0;

        const start_time    = moment(chargingData?.start_time, "YYYY-MM-DD HH:mm:ss");
        const end_time      = moment().subtract(1, "hour").subtract(30, "minutes"); // moment().add(4, 'hours');
        const diffInMinutes = end_time.diff(start_time, "minutes");

        const total_consumption = parseFloat(currentReading) - parseFloat(chargingData?.start_kwh);
        const total_duration    = diffInMinutes;
        const resident_data     = chargingData?.resident_data;

        const per_kwh_charge = resident_data?.per_kwh_charge || 0;
        const session_cost   = (per_kwh_charge * total_consumption ).toFixed(2)

        const returnObj = {
            booking_id      : chargingData?.booking_id,
            charger_id      : chargingData?.charger_id,
            reat_time_speed : ( chargeData?.power / 1000 ) || 0,
            energy_added    : total_consumption,
            session_time    : total_duration,
            session_cost    : session_cost,
            start_time      : moment(start_time).format("YYYY-MM-DD HH:mm:ss")
        }
        return  returnObj;  
 
    } catch (error) {
        return  null;  
    }
};
