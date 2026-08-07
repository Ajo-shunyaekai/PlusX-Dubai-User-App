import moment from "moment";
import db from "../../config/db.js";
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import generateUniqueId from 'generate-unique-id';
import { asyncHandler, deleteFile, mergeParam } from '../../utils.js';
import { queryDB, getPaginatedData, insertRecord, updateRecord } from '../../dbUtils.js';

import dotenv from 'dotenv';
dotenv.config();

import { tryCatchErrorHandler } from "../../middleware/errorHandler.js";

export const vehicleList = asyncHandler(async (req, resp) => {
    const {vehicle_type, page_no, vehicle_name, vehicle_model } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {vehicle_type: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const result = await getPaginatedData({
        tableName: 'vehicle',
        columns: 'vehicle_id, vehicle_name, vehicle_model, horse_power, price, image',
        searchFields: ['vehicle_name', 'vehicle_model'],
        searchTexts: [vehicle_name, vehicle_model],
        sortColumn: 'id',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        whereField: ['vehicle_type'],
        whereValue: [vehicle_type]
    });

    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Vehicle List fetched successfully!"],
        data       : result.data,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${process.env.DIR_UPLOADS}vehicle-image/`
    });
});

export const vehicleDetail = asyncHandler(async (req, resp) => {
    const { vehicle_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {vehicle_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    let gallery = [];

    const vehicleData = await queryDB(`SELECT * FROM vehicle WHERE vehicle_id= ? LIMIT 1`, [vehicle_id]);
    [gallery] = await db.execute(`SELECT image_name FROM vehicle_gallery WHERE vehicle_id = ? ORDER BY id DESC LIMIT 5`, [vehicle_id]);
    const imgName = gallery.map(row => row.image_name);
    
    return resp.json({
        status: 1,
        code: 200,
        message: ["Charging Station Details fetched successfully!"],
        data: vehicleData,
        gallery_data: imgName,
        base_url: `${process.env.DIR_UPLOADS}vehicle-image/`,
    });

});

/* Dynamic Data */
export const areaList = asyncHandler(async (req, resp) => {
    const { location_id, area_name } = mergeParam(req);

    let query = `SELECT id AS loc_id, location_id, area_name FROM locations_area_list WHERE location_id = ? AND status = ?`;
    const queryParams = [location_id, 1];

    if(area_name){
        query += ` AND area_name LIKE ?`;
        queryParams.push(`%${area_name}%`);
    }

    query += ` ORDER BY area_name ASC`;

    const [result] = await db.execute(query, queryParams);

    return resp.json({
        status: 1, 
        code: 200,
        message: ["Area List fetch successfully!"],
        area_data: result
    });
});

export const vehicleModelList = asyncHandler(async (req, resp) => {
    const {vehicle_type, make_name} = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {vehicle_type: ["required"], make_name: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    let modelData = [];

    if(vehicle_type === 'Car'){
        const [rows] = await db.execute('SELECT model FROM vehicle_brand_list WHERE status = ? AND make = ? Order by model ASC', [1, make_name]);
        modelData = rows.map(row => row.model);
    } else {
        const [rows] = await db.execute('SELECT model FROM vehicle_bike_brand_list WHERE status = ? AND make = ? Order by model ASC', [1, make_name]);
        modelData = rows.map(row => row.model);
    }
    if (make_name !== 'Other') modelData.push('Other');

    return resp.json({
        message   : ["Model List fetch successfully!"],
        area_data : modelData,
        status    : 1,
        code      : 200,
    });
});

export const vehicleBrandList = asyncHandler(async (req, resp) => {
    const {vehicle_type} = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {vehicle_type: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    let modelData = [];

    if(vehicle_type === 'Car') { 
        const [rows] = await db.execute('SELECT make FROM vehicle_brand_list WHERE status = ? AND make != ? GROUP BY make Order by make ASC',[1, "Other"]);
        modelData = rows.map(row => row.make);
        modelData.push("Other");
    } else {
        const [rows] = await db.execute('SELECT make FROM vehicle_bike_brand_list WHERE status = ?  AND make != ? GROUP BY make Order by make ASC ',[1, "Other"]);
        modelData = rows.map(row => row.make);
        modelData.push("Other");
    }
    return resp.json({
        message   : ["Make List fetch successfully!"],
        area_data : modelData,
        status    : 1,
        code      : 200,
    });
});

export const dubaiAreaList = asyncHandler(async (req, resp) => {
    const { area_name = "", page = 1 } = mergeParam(req);
    const pageSize = 20;

    const [countRows] = await db.execute(`
        SELECT 
            COUNT(id) AS total_count
        FROM 
            dubai_area
        WHERE 
            status = '1'
    `);
    const totalCount  = countRows[0].total_count;
    const total_pages = Math.ceil(totalCount / pageSize);

    let query       = "SELECT area_name as area ,id from dubai_area where status='1'";
    let queryParams = [];
 
    if( area_name !='' ) {
        query +=' AND area_name like ?'
        queryParams.push(`%${area_name}%`);
    }
    query +=' ORDER BY area_name ASC';

    if( area_name == '' && page != '' ) {  
        const offset = (page - 1) * pageSize;
        query +=` LIMIT ${offset}, ${pageSize}`;
    }
    const [dataResult] = await db.execute(query, queryParams);

    return resp.json({
        status       : 1,
        code         : 200,
        message      : ["Dubai Area List fetched successfully!"],
        total_pages  : total_pages,
        current_page : page,
        data         : dataResult
    });
});
