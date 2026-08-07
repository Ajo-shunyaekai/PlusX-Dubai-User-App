import db from "../config/db.js";
import validateFields from "../validation.js";
import { mergeParam, formatNumber } from '../utils.js';
import moment from "moment";
import Stripe from "stripe";
import dotenv from 'dotenv';
import generateUniqueId from "generate-unique-id";
import { queryDB, insertRecord, updateRecord } from '../dbUtils.js';
dotenv.config();
import { tryCatchErrorHandler } from "../middleware/errorHandler.js";

export const createIntent = async (req, resp) => {
    
    const { rider_id, rider_name, rider_email, amount, currency, booking_id, building_name, street_name='', unit_no, area, emirate, booking_type, coupon_code='' } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id    : ["required"],
        rider_name  : ["required"],
        rider_email : ["required"],
        amount      : ["required"],
        currency    : ["required"],

        // 12 March ko add hua hai
        booking_id    : ["required"],
        building_name : ["required"],
        unit_no       : ["required"],
        area          : ["required"],
        emirate       : ["required"],
        booking_type  : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const user   = await findCustomerByEmail(rider_email);
        let customerId;
        if(user.success){
            customerId = user.customer_id;
        } else {
            const customer = await stripe.customers.create({
                name    : rider_name,
                address : {
                    line1       : `${building_name} ${street_name}`, //"D55-PBU - Dubai Production City",
                    postal_code : unit_no,                       // D55-PBU
                    city        : area,                     //Dubai Production City
                    state       : emirate,                 //Dubai
                    country     : "United Arab Emirates",
                },
                email       : rider_email,
                // description : `This booking Id : ${booking_id} for POD Booking.`
            });
            customerId = customer.id;
        }
        
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer  : customerId },
            {apiVersion : '2024-04-10'}
        );
        const bookingDesc   = await sendDescBooking(booking_type, booking_id);
        const paymentIntent = await stripe.paymentIntents.create({
            amount                    : amount < 200 ? 200 : Math.floor(amount),
            currency                  : currency,
            customer                  : customerId,
            automatic_payment_methods : {
                enabled : false,
            },
            payment_method_types   : ["card"],
            use_stripe_sdk         : true,
            setup_future_usage     : 'off_session',
            payment_method_options : {
                card : {
                    request_three_d_secure : 'any',
                },
            },
            description : bookingDesc,
            metadata : {
                booking_type : booking_type,
                booking_id   : booking_id,
                user_id      : rider_id,
                coupon_code  : coupon_code,
            },
        });
        const returnData = {
            paymentIntentId     : paymentIntent.id,
            paymentIntentSecret : paymentIntent.client_secret,
            ephemeralKey        : ephemeralKey.secret,
            customer            : customerId,
            publishableKey      : process.env.STRIPE_PUBLISER_KEY,
        };
        // await updateBoking( booking_type, booking_id, rider_id, paymentIntent.id ); 
        setTimeout(async () => {
            await getPaymentIntentData( paymentIntent.id ); 
        }, 4 * 60 * 1000);
        return resp.json({
            message : ["Payment Intent Created successfully!"],
            data    : returnData,
            status  : 1,
            code    : 200,
        });
    } catch (err) {
        console.error('Error creating payment intent:', err);
        tryCatchErrorHandler(err, resp, 'Oops! There is something went wrong! While creating payment intent');
    }
};

export const createAutoDebit = async (customerId, paymentMethodId, totalAmount) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: totalAmount < 200 ? 200 : Math.floor(totalAmount),
            currency: 'aed',
            customer: customerId,
            payment_method: paymentMethodId,
            off_session: true,
            confirm: true,
        });
  
        return {
            message: "Payment completed successfully!",
            status: 1,
            code: 200,
            paymentIntent,
        };
    } catch (err) {
        console.error('Error Create Auto debit:', err);
        return {
            message : ["Error processing payment"],
            error   : err.message,
            status  : 0,
            code    : 500,
        };
        // tryCatchErrorHandler(err, resp, 'Oops! There is something went wrong! While create Auto debit');
    }
};

export const addCardToCustomer = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { rider_email, rider_name } = mergeParam(req);

    try {
        const user = await findCustomerByEmail(rider_email);
        let customerId;
        
        if(user.success){
            customerId = user.customer_id;
        } else {
            const customer = await stripe.customers.create({
                name  : rider_name,
                email : rider_email,
            });
            customerId = customer.id;
        }
        const setupIntent = await stripe.setupIntents.create({
            customer             : customerId,
            payment_method_types : ['card'],
        });
        const ephemeralKey = await stripe.ephemeralKeys.create(
            { customer   : customerId },
            { apiVersion : '2024-04-10' }
        );
        return resp.json({ 
            status                  : 1, 
            code                    : 200, 
            message                 : ['Setup intent created successfully!'],
            setup_payment_intent_id : setupIntent.id,
            client_secret           : setupIntent.client_secret,
            ephemeralKey            : ephemeralKey.secret,
            customer                : customerId,
            publishableKey          : process.env.STRIPE_PUBLISER_KEY,
        });
    } catch (error) {
        console.error('Error adding card to customer:', error);
        tryCatchErrorHandler(error, resp, error.message);
    }
};

export const customerCardsList = async (req, resp) => {
    const stripe          = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { rider_email } = mergeParam(req);
    try {
        const user = await findCustomerByEmail(rider_email);
        if(!user.success) return resp.json({status: 1, code:422, message: 'No card found, Please add a card.'});
        
        const customerId       = user.customer_id;
        const cardDetailsList  = [];
        const seenFingerprints = new Set();
        
        const customerCards = await stripe.paymentMethods.list({
            customer : customerId,
            type     : 'card',
        });
        // customerCards.data.forEach(method => {
        //     const cardDetails = {
        //         paymentMethodId   : method.id,
        //         name              : method.billing_details.name || user.name,
        //         last4             : method.card.last4,
        //         exp_month         : method.card.exp_month,
        //         exp_year          : method.card.exp_year,
        //         brand             : method.card.brand
        //     };
        //     cardDetailsList.push(cardDetails);
        // });
        customerCards.data.forEach(method => {
            const fingerprint = method.card.fingerprint;

            if (!seenFingerprints.has(fingerprint)) {
                seenFingerprints.add(fingerprint);

                cardDetailsList.push({
                    paymentMethodId : method.id,
                    name            : method.billing_details.name || user.name,
                    last4           : method.card.last4,
                    exp_month       : method.card.exp_month,
                    exp_year        : method.card.exp_year,
                    brand           : method.card.brand
                });
            }
        });
        return resp.json({
            status       : 1,
            code         : 200,
            message      : ["Card list fetch successfully"],
            total        : customerCards.data.length, 
            card_details : cardDetailsList,
        });
    } catch(error) {
        console.error('Error adding card to customer:', error);
        tryCatchErrorHandler(error, resp);
    }

};

export const removeCard = async (req, resp) => {
    // console.log('ravvi',  mergeParam(req))  
    const stripe                = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { payment_method_id } = mergeParam(req);
    if (!payment_method_id) return resp.json({ status: 0, code: 422, message: ['Payment Method ID is required.']});
    
    try {
        const detachedPaymentMethod = await stripe.paymentMethods.detach(payment_method_id);

        return resp.json({
            status          : 1,
            code            : 200,
            message         : ['Payment Method removed successfully.'],
            paymentMethodId : detachedPaymentMethod.id,
        });
    } catch (error) {
        console.error('Error detaching card:', error);
        tryCatchErrorHandler(error, resp, 'Oops! There is something went wrong! While removing card');
    }
};

export const autoPay = async (req, resp) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const {customer_id, payment_method_id, amount } = mergeParam(req);

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount         : amount,
            currency       : 'aed',
            customer       : customer_id,
            payment_method : payment_method_id,
            off_session    : true,
            confirm        : true,
        });
    
        return resp.json({
            message: "Payment from saved card completed successfully!",
            status: 1,
            code: 200,
            paymentIntent,
        });
    } catch(err) { 
        console.error('Error processing off-session payment:', err);
        tryCatchErrorHandler(err, resp);
    }
};

export const redeemCoupon = async (req, resp) => {
    const {rider_id, amount, booking_type, coupon_code } = mergeParam(req);
    
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id     : ["required"], 
        amount       : ["required"],
        booking_type : ["required"],
        coupon_code  : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    const [[{ count }]] = await db.execute('SELECT COUNT(*) AS count FROM coupon WHERE coupan_code = ?',[coupon_code]);
    if (count === 0) return resp.json({ status: 0, code: 422, message: ['The coupon you entered is not valid.'] });

    const coupon = await queryDB(`
        SELECT
            coupan_percentage, end_date, user_per_user, status, booking_for, 
            (SELECT count(id) FROM coupon_usage AS cu WHERE cu.coupan_code = coupon.coupan_code AND user_id = ?) as use_count
        FROM coupon
        WHERE coupan_code = ?
        LIMIT 1
    `, [rider_id, coupon_code]); 

    if (moment(coupon.end_date).isBefore(moment(), 'day') || coupon.status < 1){
        return resp.json({ status: 0, code: 422, message: ["The coupon you entered has expired."]} );

    } else if(coupon.booking_for != booking_type){
        return resp.json({ status: 0, code: 422, message : ["The coupon you entered is not valid."]} );

    } else if(coupon.use_count >= coupon.user_per_user){
        return resp.json({ status: 0, code: 422, message: ["This coupon code has already been used the maximum number of times."]} );
    }
    const data = {}; 
    if ( coupon.coupan_percentage != parseFloat(100) ) {
        const dis_price = ( amount  * coupon.coupan_percentage ) /100;
        const total_amt = amount - dis_price;
        
        data.dis_price  = dis_price;
        data.t_vat_amt  = Math.floor(( total_amt ) * 5) / 100;
        data.total_amt  = total_amt + data.t_vat_amt;

    } else {
        data.dis_price  = amount;
        data.t_vat_amt  = 0;
        data.total_amt  = 0;
    }
    const t_vat_amt   = data.t_vat_amt; //Math.floor(( amount ) * 5) / 100; 
    // const totalAmount = parseFloat(amount) + parseFloat( t_vat_amt );  
    const disAmount   = data.dis_price; //(totalAmount * coupon.coupan_percentage)/100;
    const finalAmount = data.total_amt; //totalAmount - disAmount;

    return resp.json({
        bookingAmount     : formatNumber(amount),
        vat_amt           : formatNumber(t_vat_amt),
        // totalAmount       : formatNumber(totalAmount),
        discount          : formatNumber(disAmount),
        data              : formatNumber(finalAmount),  //formatNumber(finalAmount),
        coupan_percentage : coupon.coupan_percentage,
        message           : ['Your discount has been successfully applied. Enjoy the savings!'],
        status            : 1,
        code              : 200
    });
};

export const createPortableChargerSubscription = async (req, resp) => {
    const {rider_id, request_id, payment_intent_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    const currDate = moment().format('YYYY-MM-DD');
    const endDate = moment().add(30, 'days').format('YYYY-MM-DD');
    const count = await queryDB(`SELECT COUNT(*) as count FROM portable_charger_subscriptions WHERE rider_id=? AND total_booking < 10 AND expiry_date > ?`,[rider_id, currDate]);
    if(count > 0) return resp.json({status:1, code:200, message: ["You have alredy Subscription plan"]});
    
    const subscriptionId = `PCS-${generateUniqueId({length:12})}`;
    
    const createObj = {
        subscription_id: subscriptionId,
        rider_id: rider_id,
        amount: 0,
        expiry_date: endDate,
        booking_limit: 10,
        total_booking: 0,
        status: 1,
        payment_date: moment().format('YYYY-MM-DD HH:mm:ss'),
    }

    if(payment_intent_id && payment_intent_id.trim() != '' ){
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
        const cardData = {
            brand:     charge.payment_method_details.card.brand,
            country:   charge.payment_method_details.card.country,
            exp_month: charge.payment_method_details.card.exp_month,
            exp_year:  charge.payment_method_details.card.exp_year,
            last_four: charge.payment_method_details.card.last4,
        };

        createObj.amount = charge.amount;  
        createObj.payment_intent_id = charge.payment_intent;  
        createObj.payment_method_id = charge.payment_method;  
        createObj.payment_cust_id = charge.customer;  
        createObj.charge_id = charge.id;  
        createObj.transaction_id = charge.payment_method_details.card.three_d_secure?.transaction_id || null;  
        createObj.payment_type = charge.payment_method_details.type;  
        createObj.payment_status = charge.status;  
        createObj.currency = charge.currency;  
        createObj.invoice_date = moment(charge.created).format('YYYY-MM-DD HH:mm:ss');
        createObj.receipt_url = charge.receipt_url;
        createObj.card_data = cardData;
    }

    const columns = Object.keys(createObj);
    const values = Object.values(createObj);
    const insert = await insertRecord('portable_charger_subscriptions', columns, values);

    const data = await queryDB(`
        SELECT 
            rider_email, rider_name
        FROM 
            portable_charger_subscriptions AS pcs
        LEFT JOIN
            riders AS r
        ON 
            r.rider_id = portable_charger_subscriptions.rider_id
        WHERE 
            pcs.subscription_id = ?
        LIMIT 1
    `, [subscriptionId]);
    const html = `<html>
        <body>
            <h4>Dear ${data.rider_name},</h4>
            <p>Thank you for subscribing to our EV Charging Plan with PlusX Electric App! We're excited to support your electric vehicle needs.</p>

            <p>Subscription Details: </p>

            <p>Plan: 10 EV Charging Sessions </p>
            <p>Duration: 30 days  </p>
            <p>Total Cost: 750 AED </p>

            <p>Important Information:</p>

            <p>Subscription Start Date: ${currDate}</p>
            <p>Subscription End Date: ${endDate}</p>

            <p>You can use your 10 charging sessions any time within the 30-day period. If you have any questions or need assistance, please do not hesitate to contact our support team.</p>

            <p>Thank you for choosing PlusX. We're committed to providing you with top-notch service and support.</p>

            <p> Best regards,<br/> PlusX Electric App Team </p>
        </body>
    </html>`;

    emailQueue.addEmail(data.rider_email, 'PlusX Electric App: Charging Subscription Confirmation', html);
    
    return resp.json({status:1, code:200, message: ["Your PlusX subscription is active! Start booking chargers for your EV now."]});
};

/* Helper function to retrieve Stripe customer ID using the provided email */
export const findCustomerByEmail = async (email) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    if (!email) return { status: 0, message: ['Email is required.']};
    
    try {
        const customers = await stripe.customers.list({ email });
        if (customers.data.length > 0) {
            return {
                success      : true,
                customer_id  : customers.data[0].id,
                name         : customers.data[0].name
            };
        } else {
            return {success: false, message: 'No customer found with this email'};
        }
    } catch (error) {
        return {success: false, message: error.message};
    }
};

/* Helper to retrive total amount from PCB or CS */
export const getTotalAmountFromService = async (booking_id, booking_type) => {
    let invoiceId, total_amount;

    if(booking_type === 'PCB'){

        // (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CS' limit 1) AS charging_start,
        // (select created_at from portable_charger_history AS bh where bh.booking_id = pcb.booking_id and order_status = 'CC' limit 1) AS charging_end
        // pcb.start_charging_level, pcb.end_charging_level, 
        const data = await queryDB(`
            SELECT 
                pcb.user_name AS rider_name,
                (select r.rider_email from riders AS r where r.rider_id = pcb.rider_id limit 1) AS rider_email,
                (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = pcb.booking_id limit 1) AS discount
            FROM
                portable_charger_booking as pcb
            WHERE 
                booking_id = ? LIMIT 1
        `, [booking_id]);

        if (!data) return { success: false, message: 'No data found for the invoice.' };
        
        // const startChargingLevels = data.start_charging_level ? data.start_charging_level.split(',').map(Number) : [0];
        // const endChargingLevels   = data.end_charging_level ? data.end_charging_level.split(',').map(Number) : [0];
        // if (startChargingLevels.length !== endChargingLevels.length) return resp.json({ error: 'Mismatch in charging level data.' });
        
        // const chargingLevelSum = startChargingLevels.reduce((sum, startLevel, index) => {
        //     const endLevel = endChargingLevels[index];
        //     return sum + Math.max(startLevel - endLevel, 0);
        // }, 0);

        // let killoWatt  = chargingLevelSum * 0.25;
        // if( chargingLevelSum < 1 ) { 
        //     const date1       = new Date(data.charging_start);
        //     const date2       = new Date(data.charging_end);
        //     const momentDate1 = moment(date1); 
        //     const momentDate2 = moment(date2);
        //     let hrsConsumed   = ( momentDate2.diff(momentDate1, 'minutes') ) / 60 ;
        //         killoWatt     = hrsConsumed * 7;
        // }
        data.kw           = 25;
        data.kw_dewa_amt  = data.kw * 0.44;   // AED : 11
        data.kw_cpo_amt   = data.kw * 0.26;   // AED : 6.5
        data.delv_charge  = 30;
        data.t_vat_amt    = 0.00; //Math.floor((data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge) * 5) / 100;
        data.total_amt    = 0.00; //data.kw_dewa_amt + data.kw_cpo_amt + data.t_vat_amt;

        total_amount = (data.total_amt) ? Math.round(data.total_amt) : 0.00;

        return {success: true, total_amount, data, message: 'Pod Amount fetched successfully'};
    } else if(booking_type === 'CS') {
        invoiceId = booking_id.replace('CS', 'INVCS');

        const data = await queryDB(`
            SELECT 
                csi.invoice_id, csi.amount, cs.request_id
            FROM 
                charging_service_invoice AS csi
            LEFT JOIN
                charging_service AS cs ON cs.request_id = csi.request_id
            WHERE 
                csi.invoice_id = ?
            LIMIT 1
        `, [invoiceId]);

        if (!data) return { success: false, message: 'No data found for the invoice.' };

        total_amount = (data.amount) ? data.amount : 0.00;
        return {success: true, total_amount, message: 'PickDrop Amount fetched successfully'};

    } else if(booking_type === 'RSA'){
 
        const data = await queryDB(`
            SELECT 
                rsa.name AS rider_name,
                (select r.rider_email from riders AS r where r.rider_id = rsa.rider_id limit 1) AS rider_email,
                (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = rsa.request_id limit 1) AS discount
            FROM
                road_assistance as rsa
            WHERE 
                request_id = ? LIMIT 1
        `, [booking_id]);

        if (!data) return { success: false, message: 'No data found for the invoice.' };
        
        data.kw           = 25;
        data.kw_dewa_amt  = data.kw * 0.44;   // AED : 11
        data.kw_cpo_amt   = data.kw * 0.26;   // AED : 6.5
        data.delv_charge  = 90;
        data.t_vat_amt    = 0.00;
        data.total_amt    = 0.00;

        total_amount = (data.total_amt) ? Math.round(data.total_amt) : 0.00;

        return {success: true, total_amount, data, message: 'Pod Amount fetched successfully'};
    } else {
        return {success: false, total_amount,  message: 'Invalid Booking Id'}; 
    }
}

// This function for IOS device made by Ravv 27 March 2025
export const getPaymentSession = async (req, resp) => {
    
    const { rider_id, rider_name, rider_email, amount, currency, booking_id, building_name, street_name='', unit_no='', area='', emirate='', booking_type, coupon_code='' } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id      : ["required"],
        rider_name    : ["required"],
        rider_email   : ["required"],
        amount        : ["required"],
        currency      : ["required"],
        booking_id    : ["required"],
        building_name : ["required"],
        // unit_no       : ["required"],
        // area          : ["required"],
        // emirate       : ["required"],
        booking_type  : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    try {
        let customerId;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const user   = await findCustomerByEmail(rider_email);
        
        if(user.success) {
            customerId = user.customer_id;

        } else {
            const customer = await stripe.customers.create({
                name    : rider_name,
                address : {
                    line1       : `${building_name} ${street_name}`, //"D55-PBU - Dubai Production City",
                    postal_code : unit_no,                       // D55-PBU
                    city        : area,                     //Dubai Production City
                    state       : emirate,                 //Dubai
                    country     : "United Arab Emirates",
                },
                email       : rider_email,
                // description : `This booking Id : ${booking_id} for POD Booking.`
            });
            customerId = customer.id;
        }
        const bookingDesc = await sendDescBooking(booking_type, booking_id);
        const session = await stripe.checkout.sessions.create({
            payment_method_types : ["card"],
            line_items : [
                {
                    price_data : {
                        currency     : currency,
                        product_data : { name : bookingDesc },
                        unit_amount  : amount < 200 ? 200 : Math.floor(amount), // $50.00
                    },
                    quantity : 1,
                },
            ],
            payment_method_options: {
                card : {
                  request_three_d_secure : "any", // Force OTP for every transaction
                },
            },
            customer   : customerId, // Existing customer ID
            // expires_at : Math.floor(Date.now() / 1000) + 1 * 60, // 5 minutes from now
            payment_intent_data : {
                setup_future_usage : "on_session", // Forces 3D Secure authentication   off_session
                metadata : {
                    booking_type : booking_type,
                    booking_id   : booking_id,
                    user_id      : rider_id,
                    coupon_code  : coupon_code,
                },
                description    : bookingDesc,
                // capture_method : 'manual',
            },
            saved_payment_method_options : {
                payment_method_save :  "enabled"
            },
            mode        : "payment",
            success_url : `${req.protocol}://${req.get('host')}/payment-success`,  
            cancel_url  : `${req.protocol}://${req.get('host')}/payment-cancel`,

            metadata : {
                booking_type : booking_type,
                booking_id   : booking_id,
                user_id      : rider_id,
                coupon_code  : coupon_code,
            }
        });
        // await updateBoking( booking_type, booking_id, rider_id, session.id ); 
        setTimeout(async () => {
            await getPaymentSessionData( session.id ); 
        }, 4 * 60 * 1000);
        return resp.json({ 
            message    : ['Paymnet session'], 
            status     : 1, 
            code       : 200,  
            url        : session.url, 
            session_id : session.id 
        });
    } catch (error) {
        console.log( error );
        tryCatchErrorHandler(error, resp, 'Oops! There is something went wrong! While create payment session');
    }
} 

export const savedcardPayment = async (req, resp) => {  //pooja@shunyaekai.tech
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    
    const { rider_id, rider_email, payment_method_id, amount, currency, booking_id,  booking_type, coupon_code='' } = mergeParam(req);
    // { rider_id, rider_name, rider_email, amount, currency, booking_id,  booking_type, coupon_code='' }

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id          : ["required"],
        rider_email       : ["required"],
        payment_method_id : ["required"],
        amount            : ["required"],
        currency          : ["required"],
        booking_id        : ["required"],
        booking_type      : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    try {
        // console.log(amount)
        const user = await findCustomerByEmail(rider_email);
        if(!user.success) return resp.json({ status : 1, code : 422, message : 'No card found, Please add a card.'});
        
        const customerId    = user.customer_id;
        const paymentIntent = await stripe.paymentIntents.create({
            amount         : amount,
            currency       : currency,
            customer       : customerId,
            payment_method : payment_method_id,
            off_session    : true,
            confirm        : true,
        });
        if(coupon_code){
            const coupon = await queryDB(`SELECT coupan_percentage FROM coupon WHERE coupan_code = ? LIMIT 1 `, [ coupon_code ]); 
    
            let coupan_percentage = coupon.coupan_percentage ;
            await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id', 'coupan_percentage'], [coupon_code, rider_id, booking_id, coupan_percentage]);
        }
        if(booking_type ==  'PCB'){
            await updateRecord('portable_charger_booking', { payment_intent_id : paymentIntent.id}, ['booking_id', 'rider_id'], [booking_id, rider_id] );

        } else if(booking_type ==  'CS'){
            await updateRecord('charging_service', { payment_intent_id : paymentIntent.id }, ['request_id', 'rider_id'], [booking_id, rider_id] );

        } else if(booking_type ==  'RSA') { 
            await updateRecord('road_assistance', { payment_intent_id : paymentIntent.id }, ['request_id', 'rider_id'], [booking_id, rider_id] );
        }
        return resp.json({
            message           : "Payment from saved card completed successfully!",
            status            : 1,
            code              : 200,
            payment_intent_id : paymentIntent.id,
            // payment_method_id : paymentIntent.payment_method, 
            // customer_id       : paymentIntent.customer
        });
    } catch(err) {
        console.error('Error processing off-session payment:', err);
        tryCatchErrorHandler(err, resp, 'Oops! There is something went wrong! While saved card payment');
    }
};

const updateBoking = async (booking_type, booking_id, rider_id, payment_intent_id ) => {
    const whereArr = [booking_id, rider_id] ;

    switch (booking_type) {
        case 'PCB':
            await updateRecord('portable_charger_booking', {payment_intent_id}, ['booking_id', 'rider_id'], whereArr);
            break;
        case 'CS':
            await updateRecord('charging_service', {payment_intent_id}, ['request_id', 'rider_id'], whereArr );
            break;
        case 'RSA':
            await updateRecord('road_assistance', {payment_intent_id}, ['request_id', 'rider_id'], whereArr );
            break;
        case 'SCI':
            await updateRecord('scan_charger_invoice', {payment_intent_id}, ['invoice_id', 'rider_id'], whereArr );
            break;
        default:
            console.log('Unknown booking type');
            break;
    }
    return true;
};

const sendDescBooking = async (booking_type, booking_id,  ) => {
    
    switch (booking_type) {
        case 'PCB':
            return `POD Booking - ${booking_id}`;

        case 'CS':
            return `Pickup & Dropoff Booking - ${booking_id}`;

        case 'RSA':
            return `Roadside Assistance Service - ${booking_id}`;

        case 'SCI':
            return `Scan Charge Invoice - ${booking_id}`;

        default:
            console.log('Unknown booking type');
            break;
    }
    return true;
};

const getPaymentSessionData = async (session_id) => {
   
    try {
        const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.status === 'open') {
            await stripe.checkout.sessions.expire(session_id);
            console.log('Session expired successfully');
            return  true;
        }  
        return  true;
    } catch (error) {
        return { error : error.message };
    }
}

const getPaymentIntentData = async (payment_intent_id) => {
   
    try {
        const stripe        = new Stripe(process.env.STRIPE_SECRET_KEY);
        const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
        const paymentStatus = ['requires_payment_method', 'requires_confirmation', 'requires_action'] ;
        
        if ( paymentStatus.includes(paymentIntent.status) ) {
            await stripe.paymentIntents.cancel(payment_intent_id);
            console.log('Session expired successfully');
            return  true;
        }  
        return  true;
    } catch (error) {
        return { error : error.message };
    }
}

export const removeAllCards = async (rider_email) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    if (!rider_email) {
        return { success: false, message: 'Rider email is required.' };
    }
 
    try {
        const user = await findCustomerByEmail(rider_email);
        if (!user.success) {
            return { success: false, message: 'Customer not found.' };
        }
 
        const customerId = user.customer_id;
        const allMethods = await stripe.paymentMethods.list({
            customer: customerId,
            type: 'card',
        });
 
        if (allMethods.data.length === 0) {
            console.log("No cards found to remove")
            return { success: true, message: 'No cards found to remove.', removed: [] };
        }
 
        const detachedIds = [];
 
        for (const pm of allMethods.data) {
            if (pm.customer) {
                const detached = await stripe.paymentMethods.detach(pm.id);
                detachedIds.push(detached.id);
            }
        }
        // console.log("all cards removed sucessfully");
        return {
            success: true,
            message: `${detachedIds.length} card(s) removed successfully.`,
            removed: detachedIds,
        };
    } catch (error) {
        console.error('Error removing cards:', error.message || error);
        return { success: false, message: 'Error removing cards.', error: error.message };
    }
};