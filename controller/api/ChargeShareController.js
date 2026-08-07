import generateUniqueId from "generate-unique-id";
import { mergeParam, formatDateTimeInQuery, asyncHandler, } from "../../utils.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, getPaginatedData,  } from '../../dbUtils.js';
import db from "../../config/db.js";

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";
 
export const addChargShare = async (req, resp) => {
    try {
        const  { 
            rider_id, rider_name, email, mobile, charger_name, description, charger_type, output, connector_type, compatible, address_id, park_no, park_floor, open_days, open_timing, address, latitude, longitude
        } = mergeParam(req); 
         
        const uploadedFiles = req.files;
        let charger_image   = '';
       
        if(req.files && req.files['charger_image']) { 
            charger_image = uploadedFiles ? uploadedFiles['charger_image'][0].filename : '';
        }
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id         : ["required"],
            rider_name       : ['required'],
            email            : ['required'],
            mobile           : ["required"], 
            charger_name     : ["required"], 
            description      : ["required"], 
            charger_type     : ["required"], 
            output           : ["required"], 
            connector_type   : ["required"], 
            //address          : ["required"],
            open_days        : ["required"], //array
            open_timing      : ["required"], //array
            compatible       : ["required"], //array
            latitude         : ["required"],
            longitude        : ["required"],
            address_id       : ['required']
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
 
        const riderAddress = await queryDB(`
            SELECT building_name, street_name, landmark, unit_no, area, emirate
            FROM rider_address
            WHERE rider_id =? and address_id = ?
            LIMIT 1 `,
        [ rider_id, address_id ]);
        if(!riderAddress) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });

        const formattedOpenDays    = Array.isArray(open_days)? JSON.stringify(open_days): open_days;
        const formattedOpenTiming  = Array.isArray(open_timing)? JSON.stringify(open_timing): open_timing;
        const formatted_compatible = Array.isArray(compatible)? JSON.stringify(compatible): compatible;
        
        const charger_id = `MCS-${generateUniqueId({ length:6 })}`;  
        const insert = await insertRecord('charge_share',
            [
                'rider_id', 'rider_name', 'email', 'charger_id', 'mobile', 'charger_name', 'description', 'charger_type', 'output', 'connector_type', 'compatible', 'park_no', 'park_floor','open_days', 'open_timing', 'charger_image', 'latitude', 'longitude', 'address_data', 'address', 'charger_status'
            ], [
                rider_id, rider_name, email, charger_id, mobile, charger_name, description, charger_type, output, connector_type, formatted_compatible, park_no, park_floor, formattedOpenDays, 
                formattedOpenTiming, charger_image, latitude, longitude, riderAddress, address, 0 
            ]
        );
        if(insert.affectedRows == 0) return resp.json({status:0, message: "Failed to add Charge share! Please try again after some time."});
 
        return resp.json({ status : 1, code : 200, message : [ "Your listing has been submitted successfully. You will be notified once your listing is approved."] });
 
    } catch (error) {
        console.log('Something went wrong in add charge share', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};
 
export const editChargShare = async (req, resp) => {
    try {
       const  { 
            charger_id, rider_name, rider_id, email, mobile, charger_name, description, charger_type, output, connector_type, compatible, address_id, park_no, park_floor, open_days, open_timing, latitude,longitude 
        } = mergeParam(req);
       
        const uploadedFiles = req.files;
        let charger_image   = '';
       
        if(req.files && req.files['charger_image']) { 
            charger_image = uploadedFiles ? uploadedFiles['charger_image'][0].filename : '';
        } 
        const { isValid, errors } = validateFields(mergeParam(req), { 
            rider_id         : ["required"], 
            mobile           : ["required"], 
            charger_name     : ["required"], 
            description      : ["required"], 
            charger_type     : ["required"], 
            output           : ["required"], 
            connector_type   : ["required"], 
            address_id       : ["required"],
            open_days        : ["required"],   //array
            open_timing      : ["required"],  //array
            compatible       : ["required"], //array
            latitude         : ["required"],
            longitude        : ["required"],
            email            : ['required'],
            rider_name       : ['required'],          
            charger_id       : ['required']  
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const chargeShareCheck = await queryDB(`
            SELECT id 
            FROM charge_share 
            WHERE charger_id = ? AND rider_id=?`,[ charger_id, rider_id ]
        );
        if(!chargeShareCheck) return resp.json({ status : 0, message : "Invailed charger" });

        const formattedOpenDays    = Array.isArray(open_days)? JSON.stringify(open_days): open_days;
        const formattedOpenTiming  = Array.isArray(open_timing)? JSON.stringify(open_timing): open_timing;
        const formatted_compatible = Array.isArray(compatible)? JSON.stringify(compatible): compatible;

        const riderAddress = await queryDB(`
            SELECT building_name, street_name, landmark, unit_no, area, emirate
            FROM rider_address
            WHERE rider_id =? and address_id = ?
            LIMIT 1 `,
        [ rider_id, address_id ]);
        if(!riderAddress) return resp.json({ message : ["Address Id not valid!"], status: 0, code: 422, error: true });
        
        let updates = {
            rider_name, email, mobile, 
            charger_id, charger_name, description, charger_type, output, connector_type, charger_image, 
            park_no, park_floor, latitude, longitude,

            compatible   : formatted_compatible,   
            open_days    : formattedOpenDays, 
            open_timing  : formattedOpenTiming, 
            address_data : riderAddress
        };                
        await updateRecord('charge_share', updates, ['rider_id', 'charger_id'], [ rider_id, charger_id ]);       
        return resp.json({ status  : 0,code:200, message :[ "Charge details updated successfully."] });

    } catch (error) {
        console.error('Something went wrong in add charge share', error);
        resp.status(500).json({ message: 'Something went wrong' });
    }
};

export const chargeShareList = async (req, resp) => {
    try {
        const { page_no= 1, search_text= '', longitude, latitude, rider_id, requirement=0 } = mergeParam(req);
        const params = {
            tableName  : ' charge_share',
            columns    : `${requirement} AS own_charge_share, rider_id, latitude, longitude,
                (
                    6371 * ACOS(
                        COS(RADIANS(${latitude})) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(${longitude})) +
                        SIN(RADIANS(${latitude})) * SIN(RADIANS(latitude))
                    )
                ) AS distance, address, 
                charger_id, mobile, charger_name, description, charger_type, output, connector_type, compatible, park_no, park_floor, open_days, open_timing, charger_image`,
            sortColumn : 'distance',
            sortOrder  : 'ASC',
            page_no,
            liveSearchFields : ['compatible', 'charger_name'],
            liveSearchTexts  : [search_text, search_text],
            limit            : 10,
            whereField       : ['charger_status'],
            whereValue       : ['1'],
            whereOperator    : ["="],     
        }
        if(requirement == 1 ) {
            params.whereField.push('rider_id');
            params.whereValue.push(rider_id);
            params.whereOperator.push('=');
        } 
        const result = await getPaginatedData(params);
        return resp.json({
            status     : 1,
            code       :201,
            message    : [" Charger share List fetch successfully!"],
            data       : result.data,
            total_page : result.totalPage,
            total      : result.total,
            base_url   : `${process.env.DIR_UPLOADS}charge-share-images/`,
        });
 
    } catch (error) {
        console.log('Error fetching station list:', error);
        tryCatchErrorHandler(req.originalUrl, error, resp );
    }
};
 
export const chargeShareDetail = asyncHandler(async (req, resp) => {
    const { charger_id, rider_id } = mergeParam(req);
    const { isValid, errors }      = validateFields(mergeParam(req), { charger_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const charger = await queryDB(`
        SELECT 
            charger_id, rider_name, email, mobile, charger_name, description, charger_type, output, connector_type, compatible, park_no, park_floor, open_days, open_timing, term_condition,charger_image, latitude, longitude, ${formatDateTimeInQuery(['created_at', 'updated_at'])},
            address_data->>'$.building_name' AS building_name, address
        FROM charge_share 
        WHERE charger_id = ?`, [charger_id]
    ); 
    if (!charger) return resp.status(404).json({status: 0, code:404, message: 'Charge share Product not found.'});
    return resp.json({
        status   : 1,
        code     : 200,
        message  : ["Charge share Details fetched successfully!"],
        data     : charger,
        base_url : `${process.env.DIR_UPLOADS}charge-share-images/`,
    });
});

export const chargeShareDelete = asyncHandler(async (req, resp) => {
    const { charger_id ,rider_id} = mergeParam(req);
    const { isValid, errors }     = validateFields(mergeParam(req), { charger_id: ["required"], rider_id :["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const charger = await db.execute(`
        DELETE FROM charge_share 
        WHERE charger_id = ? AND rider_id = ?`, [charger_id, rider_id]
    ); 
    if (!charger) return resp.status(404).json({status: 0, code: 404, message: 'Charge share could not deleted.'});
    return resp.json({
        status       : 1,
        code         : 200,
        message      : ["Charge share Deleted successfully!"],
    });
});

export const outputAndConnector = asyncHandler(async (req, resp) => {
    // const { requirement } = mergeParam(req);
    let modelData = [{ "make": "All EVs" }]; 
    
    const op_query    = `SELECT id, value FROM output_connector where status = ? order by id asc`    
    const [connector] = await db.execute(op_query, ['connector']);
    const [output_ac] = await db.execute(op_query, ['AC']);
    const [output_dc] = await db.execute(op_query, ['DC']);

    let [make_list] = await db.execute('SELECT make FROM vehicle_brand_list WHERE status = ? AND make != ? GROUP BY make Order by make ASC',[1, "Other"]);
    make_list.push({ "make": "Other" });
    
    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Out Put, Connector Data fetched successfully!"],
        weeks      : ["All Days", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",],
        // output,
        connector,
        make_list  : [...modelData, ...make_list],
        AC_output  : output_ac,
        DC_output  : output_dc
    });
});
 
export const chargeshareForMap = asyncHandler(async (req, resp) => {
    const {rider_id } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id : ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
 
    const [chargers] = await db.execute(`
        SELECT 
            address, charger_id, charger_name, latitude, longitude 
        FROM 
            charge_share 
        ORDER BY 
            id ASC 
        LIMIT 20
    `);
    return resp.json({
        status  : 1 ,
        code    : 200, 
        message : ['Charge share list fetch successfully!'],
        data    : chargers
    });
});