import db from "../../config/db.js";
import { queryDB } from "../../dbUtils.js";
import { asyncHandler, mergeParam } from "../../utils.js";
import validateFields from "../../validation.js";
import moment from "moment-timezone";


export const responseContentOld = asyncHandler(async (req, resp) => {
    const  normalize = val => (!val || val === 'null' || val === '') ? null : val;

    let { module_name, response_type, sub_module } = mergeParam(req);

    module_name   = normalize(module_name);
    sub_module    = normalize(sub_module);
    response_type = normalize(response_type);

    const { isValid, errors } = validateFields(mergeParam(req), { module_name : ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
 
    let query = `select content, sub_module from response_content  where module_name=? and status=1  `;
    let queryParams = [module_name];
    
    if (response_type != null && sub_module != null) { 
        let subModules = Array.isArray(sub_module)? sub_module : sub_module.split(',').map(s => s.trim());
        query += ` and sub_module IN (${subModules.map(() => '?').join(', ')})  AND response_type = ? `;
        queryParams.push(...subModules)
        queryParams.push(response_type);
    }    
    const [responseContent] = await db.execute(query, queryParams);
    
    if (!responseContent || responseContent.length === 0) return resp.json({ resp: 0, code: 400, msg: 'content not found!' });

    if (response_type !== null && sub_module !== null) {

        const contentMap = {};
        for (const row of responseContent) {
            if (row.sub_module) {
                contentMap[row.sub_module] = row.content;
            }
        }
        return resp.json({ message: ["single response content fetch successfully"], status: 1, code: 200, data: contentMap });
    }
    const columnMap = {
        'portable-charger' : 'portable_price',
        'pick-drop'        : 'pick_drop_price',
        // 'road-assistance'  : 'roadside_assistance_price'
    };
    const column = columnMap[module_name];
    let selectQuery = `
        SELECT heading, image ${column ? `, (SELECT ${column} FROM booking_price) AS price` : ``}
        FROM response_module
        WHERE name = ? AND status = 1
        LIMIT 1
    `; 
    const [[contentdata]] = await db.execute(selectQuery,[module_name]);
    if (!contentdata) return resp.json({ resp: 0, code: 400, msg: 'content not found!' });

    let { heading, image, price} = contentdata;
    let contentArray = responseContent.map(row => { return row.content; });

    let priceErrMsg = '';
    if(module_name == 'road-assistance') {
        const currDate = moment().utcOffset(4).format('dddd');
        const currTime = moment().utcOffset(4).format('HH:mm:ss');
        const priceQry  = `
            SELECT slot_price 
            FROM road_assistance_slot 
            WHERE status = 1 AND slot_date = ? AND ? BETWEEN start_time AND end_time ORDER BY start_time ASC  
            LIMIT 1`;
        const priceData = await queryDB(priceQry, [ currDate, currTime]);
        price           = priceData?.slot_price || 0;
        const slotContent = await queryDB(` SELECT content FROM  response_content WHERE  module_name = ? AND response_type = ? Order by id desc LIMIT 1 `, [ `${module_name}-price`, 'error' ]);

        priceErrMsg = slotContent?.content || '';
    }
    let data = { 
        content    : contentArray, 
        image      : image || null, 
        heading    : heading ||null, 
        price      : price || 0,
        slotErrMsg : priceErrMsg,
        zeroPercentModal:'If your EV has 0% battery, the portable power service will not work. Kindly book our Roadside (Emergency) EV charging service.'
    };
    return resp.json({ message: ["Response data fetch successfully"], status: 1, code: 200, data });
});

export const responseContent = asyncHandler(async (req, resp) => {
    const  normalize = val => (!val || val === 'null' || val === '') ? null : val;

    let { module_name, response_type, sub_module } = mergeParam(req);

    module_name   = normalize(module_name);
    sub_module    = normalize(sub_module);
    response_type = normalize(response_type);

    const { isValid, errors } = validateFields(mergeParam(req), { module_name : ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const buildModuleData = async (contentRows, contactNo = '', responseType = null) => {
        const columnMap = {
            'portable-charger' : 'portable_price',
            'pick-drop'        : 'pick_drop_price',
        };
        const column = !responseType ? columnMap[module_name] : null;
        let selectQuery = `
            SELECT heading, image ${column ? `, (SELECT ${column} FROM booking_price) AS price` : ``}
            FROM response_module
            WHERE name = ? AND status = 1
            ${responseType ? 'AND sub_module = ?' : 'AND (sub_module IS NULL OR sub_module = \'\')'}
            LIMIT 1
        `;
        const moduleParams = responseType ? [ module_name, responseType ] : [ module_name ];
        const [[contentdata]] = await db.execute(selectQuery, moduleParams);

        if (!contentdata) return null;

        let { heading, image, price } = contentdata;
        let priceErrMsg = '';
        price = price ?? 0;

        if (module_name == 'road-assistance') {
            const currDate = moment().utcOffset(4).format('dddd');
            const currTime = moment().utcOffset(4).format('HH:mm:ss');
            const priceData = await queryDB(`
                SELECT slot_price
                FROM road_assistance_slot
                WHERE status = 1 AND slot_date = ? AND ? BETWEEN start_time AND end_time ORDER BY start_time ASC
                LIMIT 1`, [ currDate, currTime ]);
            price = priceData?.slot_price || 0;
            const slotContent = await queryDB(
                ` SELECT content FROM response_content WHERE module_name = ? AND response_type = ? Order by id desc LIMIT 1 `,
                [ `${module_name}-price`, 'error' ]
            );
            priceErrMsg = slotContent?.content || '';
        }

        return {
            content          : contentRows.map(row => row.content),
            image            : image || null,
            heading          : heading || null,
            price            : price || 0,
            slotErrMsg       : priceErrMsg,
            zeroPercentModal : 'If your EV has 0% battery, the portable power service will not work. Kindly book our Roadside (Emergency) EV charging service.',
            ...(contactNo ? { teamContactNo: contactNo } : {}),
        };
    };

    // module_name + response_type only — e.g. portable-charger service-unavailable popup
    if (response_type != null && sub_module == null) {
        const isPortableServiceUnavailable = module_name === 'portable-charger' && response_type === 'service-unavailable';

        const [filteredRows] = await db.execute(`
            SELECT content, additional_content${isPortableServiceUnavailable ? ', status' : ''}
            FROM response_content
            WHERE module_name = ? AND response_type = ? ${isPortableServiceUnavailable ? '' : 'AND status = 1'}
            ORDER BY id ASC
        `, [ module_name, response_type ]);

        if (!filteredRows.length) {
            return resp.json({ resp: 0, code: 400, msg: 'content not found!' });
        }

        const contactRow = filteredRows.find(row => row.additional_content);

        if (isPortableServiceUnavailable) {
            const bodyText = (filteredRows[1]?.content || '')
                .replace(/\+?\d[\d\s-]{6,}\d/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

            return resp.json({
                message: ["Response data fetch successfully"],
                status: 1,
                code: 200,
                data: {
                    heading               : filteredRows[0]?.content || '',
                    podUnavailableContent : bodyText,
                    teamContactNo         : contactRow?.additional_content || '',
                    serviceUnvailable     : filteredRows[0].status ? 1 : 0,
                },
            });
        }

        const data = await buildModuleData(filteredRows, contactRow?.additional_content || '', response_type);
        if (!data) return resp.json({ resp: 0, code: 400, msg: 'content not found!' });

        return resp.json({ message: ["Response data fetch successfully"], status: 1, code: 200, data });
    }

    let query = `select content, sub_module from response_content where module_name=? and status=1 AND response_type IS NULL `;
    let queryParams = [module_name];

    if (response_type != null && sub_module != null) {
        let subModules = Array.isArray(sub_module)? sub_module : sub_module.split(',').map(s => s.trim());
        query = `select content, sub_module from response_content where module_name=? and status=1 `;
        query += ` and sub_module IN (${subModules.map(() => '?').join(', ')})  AND response_type = ? `;
        queryParams = [module_name, ...subModules, response_type];
    }
    const [responseContentRows] = await db.execute(query, queryParams);

    if (!responseContentRows || responseContentRows.length === 0) return resp.json({ resp: 0, code: 400, msg: 'content not found!' });

    if (response_type !== null && sub_module !== null) {

        const contentMap = {};
        for (const row of responseContentRows) {
            if (row.sub_module) {
                contentMap[row.sub_module] = row.content;
            }
        }
        return resp.json({ message: ["single response content fetch successfully"], status: 1, code: 200, data: contentMap });
    }

    const data = await buildModuleData(responseContentRows);
    if (!data) return resp.json({ resp: 0, code: 400, msg: 'content not found!' });

    return resp.json({ message: ["Response data fetch successfully"], status: 1, code: 200, data });
});

export const countryList = asyncHandler(async (req, resp) => {
    const [list] = await db.execute(`SELECT name, country_code, dial_code FROM countries ORDER BY name ASC`);
    return resp.json({status: 1, code: 200, message: 'Country List', data: list});
});
