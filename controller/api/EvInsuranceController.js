import moment from "moment";
import dotenv from 'dotenv';
// import db from "../../config/db.js";
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";

import { insertRecord, queryDB, getPaginatedData, updateRecord } from '../../dbUtils.js';
import { asyncHandler, createNotification, formatDateInQuery, formatDateTimeInQuery, mergeParam} from "../../utils.js";
dotenv.config();

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
import { io } from '../../server.js';

export const addInsurance = asyncHandler(async (req, resp) => {
    try { 
        const { rider_id, owner_name, country_code, mobile_no, vehicle_id, insurance_expiry_date } = mergeParam(req);
        const { isValid, errors } = validateFields(mergeParam(req), {
            rider_id              : ["required"],
            owner_name            : ["required"], 
            country_code          : ["required"],
            mobile_no             : ["required"],
            vehicle_id            : ["required"],
            insurance_expiry_date : ["required"],
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });   
    
        if (!req.files || !req.files['prev_insurance']) return resp.json({ status: 0, code: 422, message: ["Previous Insurance is required."] });

        if (!req.files || !req.files['driving_licence']) return resp.json({ status: 0, code: 422, message: ["Driving Licence is required."] });

        if (!req.files || !req.files['emirates_id']) return resp.json({ status: 0, code: 422, message: ["Emirates ID is required."] });

        const riderVehicle = await queryDB(`
            SELECT 
                vehicle_make, vehicle_model, vehicle_specification, emirates, vehicle_code, vehicle_number 
            FROM 
                riders_vehicles
            WHERE 
                rider_id = ? and vehicle_id = ?
            LIMIT 1 `,
        [ rider_id, vehicle_id ]);
        if(!riderVehicle) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });

        const prev_insurance   = req.files['prev_insurance'].map(file => file.filename).join('*');
        const driving_licence  = req.files['driving_licence'].map(file => file.filename).join('*');
        const emirates_id      = req.files['emirates_id'].map(file => file.filename).join('*');
        const fInsuranceExpiry = moment(insurance_expiry_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const vehicle_data     = riderVehicle.vehicle_make + ", " + riderVehicle.vehicle_model+ ", "+ riderVehicle.vehicle_specification+ ", "+ riderVehicle.emirates+ "-" + riderVehicle.vehicle_code + "-"+ riderVehicle.vehicle_number ;

        const insert = await insertRecord('ev_insurance', [
            'insurance_id', 'rider_id', 'owner_name', 'country_code', 'mobile_no', 'vehicle', 'vehicle_data',
            'insurance_expiry', 'driving_licence', 'car_images', 'emirates_id', 
        ], [
            'EVI', rider_id, owner_name, country_code, mobile_no, vehicle_id, vehicle_data,
            fInsuranceExpiry, driving_licence, prev_insurance, emirates_id, 
        ]);
        if(insert.affectedRows === 0 ) return resp.json({status:0, code:200, error: true, message: ['Oops! There is something went wrong! Please Try Again']});
        const lastId       = insert.insertId;
        const insurance_id = `EVI-${String(lastId).padStart(4, "0")}`;
        await updateRecord('ev_insurance', {insurance_id}, ['id'], [lastId]);

        const href    = 'ev_insurance_booking/' + insurance_id;
        const heading = 'EV Insurance Booking!';
        const desc    = `EV Insurance Booking Received - ID: ${insurance_id}`;
        createNotification(heading, desc, 'EV Insurance', 'Admin', 'Rider',  rider_id, '', href);
        const html = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>We have received a new lead for the EV Insurance service. Please find the details below:</p>
                <p>Customer Name : ${owner_name}</p> 
                <p>Contact No. : ${country_code} - ${mobile_no}</p> 
                <p>Vehicle Details : ${vehicle_data}</p> 
                <p>Insurance Expires On : ${moment(insurance_expiry_date, 'YYYY-MM-DD').format('DD MMM YYYY')}</p>
                <br /> <br /> 
                <p> Best regards,<br/> PlusX Electric Team </p>
            </body>
        </html>`;
        const allFiles = [
            ...(req.files['prev_insurance'] || []),
            ...(req.files['driving_licence'] || []),
            ...(req.files['emirates_id'] || [])
        ];
        const attachments = allFiles.map(file => ({
            filename : file.filename,   // send with original name
            // path  : path.resolve(file.path), // absolute path file.path, //path.join(process.cwd(), file.path), //
            content  : file.buffer, //fs.createReadStream(file.path)
            // content  : fs.createReadStream(file.path)  this is work on local
        }));
        
        const adminEmails = [ process.env.MAIL_CHINTAN, process.env.MAIL_NADIA ];
        emailQueue.addEmail(adminEmails, `EV Insurance Lead : ${insurance_id}`, html, null, attachments);
        io.emit('notification-list', {msCount : 1});
        return resp.json({
            status  : 1,
            code    : 200,
            error   : false,
            message : ["Thank you! We've received your details. Our team will contact you shortly."],
        });

    } catch(err) {
        console.log(err);
        tryCatchErrorHandler(req.originalUrl, err, resp);
        // return resp.status(500).json({status: 0, code: 500, message: "Oops! There is something went wrong! Please Try Again" });
    }
});

export const insuranceList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no=1, mobile_no, vehicle } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), { rider_id : ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    let whereField = ['rider_id'];
    let whereValue = [rider_id];

    if(mobile_no){
        whereField.push('mobile_no');
        whereValue.push(`%${mobile_no}%`);
    }
    if(vehicle){
        whereField.push('vehicle');
        whereValue.push(`%${vehicle}%`);
    }
    const result = await getPaginatedData({
        tableName: 'ev_insurance',
        columns: `insurance_id, owner_name, country, country_code, mobile_no, vehicle, emirates_id,
            ${formatDateTimeInQuery(['created_at'])}, vehicle_data`,
        sortColumn : 'id',
        sortOrder  : 'DESC',
        limit      : 10,
        page_no,
        whereField,
        whereValue,
        whereOperator: ['=', 'LIKE', 'LIKE'],
    });
    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Insurance list fetch successfully!"],
        data       : result.data,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${process.env.DIR_UPLOADS}insurance-images/`,
        noResultMsg : 'Secure your EV today - get insured and drive worry-free.'
    });
});

export const insuranceDetails = asyncHandler(async (req, resp) => {
    const {rider_id, insurance_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], insurance_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const insurance = await queryDB(`
        SELECT 
            owner_name, country_code, mobile_no, vehicle_data, car_images as prev_insurance, driving_licence, emirates_id, ${formatDateInQuery(['insurance_expiry'])}, ${formatDateTimeInQuery(['created_at', 'updated_at'])}
        FROM 
            ev_insurance AS ev
        WHERE
            rider_id = ? AND insurance_id = ?
        LIMIT 1
    `, [rider_id, insurance_id]);

    return resp.json({
        message        : [ "Insurance details fetch successfully!" ],
        insurance_data : insurance,
        status         : 1, 
        code           : 200, 
        base_url       : `${process.env.DIR_UPLOADS}insurance-images/`,
    });
});
