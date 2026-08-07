import { updateRecord } from '../dbUtils.js';
import { asyncHandler } from "../utils.js";
import db from "../config/db.js";
import moment from "moment-timezone";

import { taskQueue  } from "../taskQueue.js";

export function addTaskQ(fn) {
    return taskQueue.add(fn);
}

export const makeBookingHistoryPOD = asyncHandler(async (req, resp) => {

    const [invoiceList] = await db.execute(`
        SELECT 
            invoice_id, amount, invoice_date,
            (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = portable_charger_invoice.request_id LIMIT 1) AS discount 
        FROM portable_charger_invoice 
        WHERE price_details IS NULL`, []
    ); 
    const priceMap = new Map([
        [12000, { discount: 0,   b_price: 114 }],
        [9000,  { discount: 0,   b_price: 85 }],
        [6825,  { discount: 0,   b_price: 65 }],
        [3150,  { discount: 0,   b_price: 30 }],
        [0,     { discount: 100, b_price: 30 }],
        [315,   { discount: 90,  b_price: 30 }],
        [682,   { discount: 90,  b_price: 65 }],
    ]);
    const compareDate = moment('2025-09-12', 'YYYY-MM-DD');

    for (const invoice of invoiceList) {

        const invoiceDate     = moment(invoice.invoice_date);
        const invoiceAmount   = Number(invoice.amount) || 0;
        const invoiceDiscount = Number(invoice.discount) || 0;

        let baseAmount      = 65; // default
        let discountPercent = invoiceDiscount;

        if (invoiceAmount < 1) {
            baseAmount      = invoiceDate.isBefore(compareDate) ? 30 : 65;
            discountPercent = discountPercent < 1 ? 100 : discountPercent;
        } else {
            const matched = priceMap.get(invoiceAmount);
             
            if (matched) {
                baseAmount      = matched.b_price;
                discountPercent = matched.discount;
            }
        }
        const kwConsume = 25;
        const dewaUnit  = 0.44;
        const cpoUnit   = 0.26;

        const kwDewaAmt      = kwConsume * dewaUnit;
        const kwCpoAmt       = kwConsume * cpoUnit;
        const deliveryCharge = baseAmount - (kwDewaAmt + kwCpoAmt);

        let discountAmt = 0;
        let vatAmount   = 0;
        let totalPrice  = 0;

        if (discountPercent > 0) {

            if (discountPercent !== 100) {

                discountAmt = (baseAmount * discountPercent) / 100;
                const afterDiscount = baseAmount - discountAmt;

                vatAmount = (afterDiscount * 5) / 100;
                totalPrice = afterDiscount + vatAmount;

            } else {

                discountAmt = baseAmount;
                vatAmount = 0;
                totalPrice = 0;
            }

        } else {
            vatAmount = (baseAmount * 5) / 100;
            totalPrice = baseAmount + vatAmount;
        }
        const priceDetails = {
            amount          : baseAmount,
            discount_prcnt  : discountPercent,
            kw_consume      : kwConsume,
            dewa_unit_price : dewaUnit,
            cpo_unit_price  : cpoUnit,
            kw_dewa_amt     : kwDewaAmt,
            kw_cpo_amt      : kwCpoAmt,
            delivry_charge  : deliveryCharge,
            discount_amt    : discountAmt,
            vat_amount      : vatAmount,
            total_price     : totalPrice
        };
        await updateRecord( 'portable_charger_invoice', { price_details: priceDetails }, 
            ['invoice_id'], [invoice.invoice_id]
        );
    }
    return resp.json({ length: invoiceList.length });
});

export const makeBookingHistoryRSA = asyncHandler(async (req, resp) => {

    const [invoiceList] = await db.execute(`
        SELECT 
            invoice_id, amount,
            (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = rsi.request_id LIMIT 1) AS discount
        FROM road_assistance_invoice AS rsi 
        WHERE price_details IS NULL`, []
    );
    const priceMap = new Map([
        [500,   { discount: 0,     b_price: 4.8 }],
        [200,   { discount: 0,     b_price: 2 }],
        [9000,  { discount: 0,     b_price: 85 }],
        [13125, { discount: 0,     b_price: 125 }],
        [328,   { discount: 97.50, b_price: 125 }],
        [394,   { discount: 97.00, b_price: 125 }],
        [0,     { discount: 100,   b_price: 125 }],
        [15225, { discount: 0,     b_price: 145 }],
    ]);
    const compareDate = moment('2025-09-12', 'YYYY-MM-DD');

    for (const invoice of invoiceList) {
        addTaskQ(async () => { 
             
            const invoiceAmount   = Number(invoice.amount) || 0;
            const invoiceDiscount = Number(invoice.discount) || 0;

            let baseAmount      = 125; // default
            let discountPercent = invoiceDiscount;

            const matched = priceMap.get(invoiceAmount);
            if (matched) {
                baseAmount      = matched.b_price;
                discountPercent = matched.discount;
            }
            const kwConsume = 25;
            const dewaUnit  = 0.44;
            const cpoUnit   = 0.26;

            const kwDewaAmt      = kwConsume * dewaUnit;
            const kwCpoAmt       = kwConsume * cpoUnit;
            const deliveryCharge = baseAmount - (kwDewaAmt + kwCpoAmt);

            let discountAmt = 0;
            let vatAmount   = 0;
            let totalPrice  = 0;

            if (discountPercent > 0) {

                if (discountPercent !== 100) {

                    discountAmt = (baseAmount * discountPercent) / 100;
                    const afterDiscount = baseAmount - discountAmt;

                    vatAmount = (afterDiscount * 5) / 100;
                    totalPrice = afterDiscount + vatAmount;

                } else {
                    discountAmt = baseAmount;
                    vatAmount = 0;
                    totalPrice = 0;
                }

            } else {
                vatAmount = (baseAmount * 5) / 100;
                totalPrice = baseAmount + vatAmount;
            }
            const priceDetails = {
                amount          : baseAmount,
                discount_prcnt  : discountPercent,
                kw_consume      : kwConsume,
                dewa_unit_price : dewaUnit,
                cpo_unit_price  : cpoUnit,
                kw_dewa_amt     : kwDewaAmt,
                kw_cpo_amt      : kwCpoAmt,
                delivry_charge  : deliveryCharge,
                discount_amt    : discountAmt,
                vat_amount      : vatAmount,
                total_price     : totalPrice
            };
            // return resp.json({ priceDetails });
            await updateRecord( 'road_assistance_invoice', { price_details: priceDetails }, 
                ['invoice_id'], [invoice.invoice_id]
            );
        });
    }
    return resp.json({ length: invoiceList.length, message: "Data in tasks queued " });
});

export const makeBookingHistoryValet = asyncHandler(async (req, resp) => {

    const [invoiceList] = await db.execute(`
        SELECT 
            invoice_id, amount,
            (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = rsi.request_id LIMIT 1) AS discount
        FROM charging_service_invoice AS rsi
        WHERE price_details IS NULL`, []
    ); 
    const priceMap = new Map([
        [5900, { discount: 0,   b_price: 56 }],
        [0,    { discount: 100, b_price: 59 }],
        [200,  { discount: 0,   b_price: 2 }],
        [4900, { discount: 0,   b_price: 47 }],
        [3900, { discount: 0,   b_price: 37 }],
        [245,  { discount: 94,  b_price: 39 }],
        [4095, { discount: 0,   b_price: 39 }],
    ]);
    for (const invoice of invoiceList) {
        addTaskQ(async () => { 
            
            const invoiceAmount   = Number(invoice.amount) || 0;
            const invoiceDiscount = Number(invoice.discount) || 0;

            let baseAmount      = 39; // default
            let discountPercent = invoiceDiscount;

            const matched = priceMap.get(invoiceAmount);
            if (matched) {
                baseAmount      = matched.b_price;
                discountPercent = matched.discount;
            }
            let discountAmt = 0;
            let vatAmount   = 0;
            let totalPrice  = 0;

            if (discountPercent > 0) {

                if (discountPercent !== 100) {

                    discountAmt = (baseAmount * discountPercent) / 100;
                    const afterDiscount = baseAmount - discountAmt;

                    vatAmount = (afterDiscount * 5) / 100;
                    totalPrice = afterDiscount + vatAmount;

                } else {
                    discountAmt = baseAmount;
                    vatAmount = 0;
                    totalPrice = 0;
                }
            } else {
                vatAmount = (baseAmount * 5) / 100;
                totalPrice = baseAmount + vatAmount;
            }
            const priceDetails = {
                amount          : baseAmount,
                discount_prcnt  : discountPercent,
                kw_consume      : 0,  
                dewa_unit_price : 0,  
                cpo_unit_price  : 0,
                kw_dewa_amt     : 0,
                kw_cpo_amt      : 0,
                delivry_charge  : 0,
                discount_amt    : discountAmt,
                vat_amount      : vatAmount,
                total_price     : totalPrice
            };
            await updateRecord( 'charging_service_invoice', { price_details: priceDetails }, 
                ['invoice_id'], [invoice.invoice_id]
            );
        });
    }
    return resp.json({ length: invoiceList.length, message: "Data in tasks queued " });
});