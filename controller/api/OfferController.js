import moment from "moment";
import validateFields from "../../validation.js";
import { queryDB, getPaginatedData, insertRecord } from '../../dbUtils.js';
import { asyncHandler, formatDateTimeInQuery, mergeParam } from '../../utils.js';

export const offerList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const result = await getPaginatedData({
        tableName: 'offer',
        columns: 'id, offer_id, offer_name, offer_exp_date, offer_image, offer_url',
        sortColumn: 'id',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        whereField: ['offer_exp_date'],
        whereValue: [moment().format('YYYY-MM-DD')],
        whereOperator: ['>=']
    });

    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Offer List fetched successfully!"],
        data       : result.data,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${process.env.DIR_UPLOADS}offer/`,
    });
});

export const offerDetail = asyncHandler(async (req, resp) => {
    const {rider_id, offer_id } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], offer_id: ["required"]});
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const offer = await queryDB(`SELECT *, ${formatDateTimeInQuery(['created_at', 'updated_at', 'offer_exp_date'])} FROM offer WHERE offer_id= ? LIMIT 1`, [offer_id]);
    
    return resp.json({
        status   : 1,
        code     : 200,
        message  : ["Offer Details fetched successfully!"],
        data     : offer,
        base_url : `${process.env.DIR_UPLOADS}offer/`,
    });
});

export const offerHistory = async (req, resp) => {
    const { rider_id, offer_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), { rider_id: ["required"], offer_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    /* const offer = await queryDB(`SELECT EXISTS (SELECT 1 FROM offer_history WHERE offer_id = ? AND rider_id = ?) AS exist`, [offer_id, rider_id]);
    if(offer.exist){
        return resp.json({ status: 0, code: 422 });
    }else{
        const insert = await insertRecord('offer_history', ['offer_id', 'rider_id'], [offer_id, rider_id]);
        return resp.json({
            status: insert.affectedRows > 0 ? 1 : 0, code: insert.affectedRows > 0 ? 200 : 422,
            message: insert.affectedRows > 0 ? ["Offer history created successfully"] : ["Failed to insert, Please try again."],
        });
    } */

    const insert = await insertRecord('offer_history', ['offer_id', 'rider_id'], [offer_id, rider_id]);

    return resp.json({
        status: insert.affectedRows > 0 ? 1 : 0,
        code: insert.affectedRows > 0 ? 200 : 422,
        message: insert.affectedRows > 0 ? ["Offer history created successfully"] : ["Failed to insert, Please try again."],
    });
};