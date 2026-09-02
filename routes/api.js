
import { Router } from "express";
import { handleFileUpload } from "../fileUpload.js";
import multer from "multer";
import { apiAuthorization } from '../middleware/apiAuthorizationMiddleware.js';
import { apiAuthentication } from '../middleware/apiAuthenticationMiddleware.js';

import { offerList, offerDetail, offerHistory } from '../controller/api/OfferController.js';

import { redeemCoupon, createIntent, createPortableChargerSubscription, addCardToCustomer, customerCardsList, removeCard, autoPay, getPaymentSession, savedcardPayment  } from '../controller/PaymentController.js';

import { stationList, stationDetail, nearestChargerList } from '../controller/api/ChargingStationController.js';

import { serviceRequest, requestList, requestDetails, evChargerList, accessoriesList, evchargerDetails, purchaseHistoryList, purchaseHistoryDetails  } from '../controller/api/ChargingInstallationServiceController.js';

import { rsaInvoice, pickAndDropInvoice, portableChargerInvoice, scanChargerInvoiceNew } from '../controller/InvoiceController.js';
// Legacy scan invoice (no map-table awareness)
// import { scanChargerInvoice } from '../controller/InvoiceController.js';

import { addInsurance, insuranceList, insuranceDetails } from '../controller/api/EvInsuranceController.js';

import { login, register, forgotPassword, regsCreateOTP, createOTP, verifyOTP, home, getRiderData, updateProfile, deleteImg, logout, updatePassword, locationList, locationAdd, notificationList, addRiderAddress, riderAddressList, deleteRiderAddress, deleteAccount, addRiderVehicle, editRiderVehicle, riderVehicleList, deleteRiderVehicle, editRiderAddress, defaultAddress, defaultVehicle } from "../controller/api/RiderController.js";

import { addRoadAssistance, roadAssistanceList, roadAssistanceDetail, roadAssistanceInvoiceDetail, userFeedbacRSABooking } from '../controller/api/RoadAssistanceController.js';

import {vehicleList, vehicleDetail, areaList, vehicleModelList, vehicleBrandList, dubaiAreaList } from '../controller/api/VehicleController.js';

import { chargerList, packageList, chargerBooking, chargerBookingList,chargerBookingDetail, getPcSlotList, getPcSubscriptionList, userCancelPCBooking, reScheduleBooking, userFeedbackPCBooking, getPcSlotDateList, podInvoiceDetails } from '../controller/api/PortableChargerController.js';

import { getChargingServiceSlotList, requestService, listServices, getServiceOrderDetail, getInvoiceDetail, cancelValetBooking, userFeedbackValetBooking, rescheduleService, getChargingServiceDateList
} from '../controller/api/ChargingServiceController.js';

import { getPaymentdetails, getPaymentSessionData } from '../controller/TestController.js';  
import { responseContent, countryList } from '../controller/api/ContentController.js';

import { outputAndConnector, addChargShare, editChargShare, chargeShareList, chargeShareDetail, chargeShareDelete, chargeshareForMap } from '../controller/api/ChargeShareController.js'; 
//import { makeBookingHistoryPOD, makeBookingHistoryRSA, makeBookingHistoryValet } from '../controller/InvoiceUpdateController.js'; 

// Legacy scan-charge (single community_resident.community_id join) — replaced by ScanChargerControllerNew.js
// import { chargingStart, stopCharge, chargingDetail, chargingHistory, scanChargeInvoices, scanChargeInvoiceDetail } from '../controller/api/ScanChargeController.js';

import {
    residentCommunities,
    chargingStart,
    stopCharge,
    chargingDetail,
    chargingHistory,
    scanChargeInvoices,
    scanChargeInvoiceDetail,
} from '../controller/api/ScanChargerControllerNew.js';
 
import rateLimit from 'express-rate-limit';

const router = Router();

const limiter = rateLimit({
    windowMs     : 70 * 1000,
    max          : 4,
    keyGenerator : (req) => req.body.device_id || req.ip,
    handler      : (req, res, next, options) => {
        console.log(req.body.device_id || req.ip);
        console.error('Rate limit exceeded:', req.body.device_id || req.ip);
        return res.json({ status : 0, code : options.statusCode, message : [`You have already requested the OTP twice. Please wait for 1 minutes before trying again.`,  ]});
    },
});

/* -- Api Auth Middleware -- */
const authzRoutes = [
    /* API Routes */
    {method: 'post', path: '/rider-login',           handler: login},
    {method: 'post', path: '/registration',          handler: register},
    {method: 'post', path: '/rider-forgot_password', handler: forgotPassword},
    {method: 'post', path: '/create-otp',            handler: createOTP},
    {method: 'post', path: '/regs-create-otp',       handler: regsCreateOTP},
    {method: 'post', path: '/verify-otp',            handler: verifyOTP},
    
    /* Dynamic List */
    {method: 'get', path: '/location-list', handler: locationList},
    {method: 'get', path: '/location-add',  handler: locationAdd},
    {method: 'get', path: '/country-list',  handler: countryList},
    
    /* Vehicle Routes */
    { method: 'get',  path: '/location-area-list',         handler: areaList },
    { method: 'post', path: '/vehicle-brand-list',         handler: vehicleBrandList },
    { method: 'post', path: '/vehicle-model-list',         handler: vehicleModelList },
    { method: 'get',  path: '/dubai-area-list',            handler: dubaiAreaList },
    { method: 'get',  path: '/response-content',           handler: responseContent },
    { method: 'get',  path: '/output-power-and-connector-list', handler: outputAndConnector },

    
];
authzRoutes.forEach(({ method, path, handler }) => {
    const middlewares = [apiAuthorization];
    if(path === '/registration'){
        const noUpload = multer();
        middlewares.push(noUpload.none()); 
    }
    if(path === '/create-otp'){
        middlewares.push(limiter); 
    }
    router[method](path, ...middlewares, handler);
});

/* -- Api Auth & Api Authz Middleware -- */
const authzAndAuthRoutes = [
    { method: 'get',  path: '/rider-home',                 handler: home },
    { method: 'get',  path: '/get-rider-data',             handler: getRiderData },
    { method: 'post', path: '/rider-profile-change',       handler: updateProfile },
    { method: 'get',  path: '/rider-profile-image-delete', handler: deleteImg },
    { method: 'get',  path: '/rider-account-delete',       handler: deleteAccount },
    { method: 'post', path: '/rider-logout',               handler: logout },
    { method: 'post', path: '/rider-change_password',      handler: updatePassword },
    { method: 'get',  path: '/rider-notification-list',    handler: notificationList },
    { method: 'post', path: '/rider-address-add',          handler: addRiderAddress },
    { method: 'get',  path: '/rider-address-list',         handler: riderAddressList },
    { method: 'post', path: '/rider-address-edit',          handler: editRiderAddress },
    { method: 'get',  path: '/rider-address-delete',       handler: deleteRiderAddress },
    { method: 'post', path: '/rider-vehicle-add',          handler: addRiderVehicle },
    { method: 'post', path: '/rider-vehicle-edit',         handler: editRiderVehicle },
    { method: 'get',  path: '/rider-vehicle-list',         handler: riderVehicleList },
    { method: 'get',  path: '/rider-vehicle-delete',       handler: deleteRiderVehicle },
    { method: 'post', path: '/rider-address-default',      handler: defaultAddress },
    { method: 'post', path: '/rider-vehicle-default',      handler: defaultVehicle },

    /* Public Charging Station */
    { method: 'get', path: '/charging-station-list',         handler: stationList },
    { method: 'get', path: '/nearest-charging-station-list', handler: nearestChargerList },
    { method: 'get', path: '/charging-station-detail',       handler: stationDetail },

    /* Road Assistance Routes */
    { method: 'post', path: '/road-assistance',                handler: addRoadAssistance },
    { method: 'get',  path: '/road-assistance-list',           handler: roadAssistanceList },
    { method: 'get',  path: '/road-assistance-details',        handler: roadAssistanceDetail },
    { method: 'get',  path: '/road-assistance-invoice-detail', handler: roadAssistanceInvoiceDetail },
    { method: 'post', path: '/feedback-road-assistance',       handler: userFeedbacRSABooking },

    /* Installation Service Routes */
    { method: 'post', path: '/charging-installation-service',  handler: serviceRequest },
    { method: 'get',  path: '/charging-installation-list',     handler: requestList },
    { method: 'get',  path: '/charging-installation-detail',   handler: requestDetails },

    /* Vehicle Routes */
    { method: 'get',  path: '/vehicle-list',          handler: vehicleList },
    { method: 'get',  path: '/vehicle-detail',        handler: vehicleDetail },
    
    /* Charging Service */
    { method: 'post', path: '/charging-service-slot-list',   handler: getChargingServiceSlotList },
    { method: 'post', path: '/charging-service',             handler: requestService },
    { method: 'get',  path: '/charging-service-list',        handler: listServices },
    { method: 'get',  path: '/charging-service-details',     handler: getServiceOrderDetail },
    { method: 'get',  path: '/pick-and-drop-invoice-detail', handler: getInvoiceDetail },
    { method: 'post', path: '/charging-service-cancel',      handler: cancelValetBooking },
    { method: 'post', path: '/feedback-charging-service',    handler: userFeedbackValetBooking },
    { method: 'post', path: '/reschedule-charging-service', handler: rescheduleService },
    { method: 'get', path: '/charging-service-slot-date-list', handler: getChargingServiceDateList },

    /* Portable charger */
    { method: 'get',  path: '/portable-charger-list',            handler: chargerList },
    { method: 'get',  path: '/charging-package-list',    handler: packageList },
    { method: 'post', path: '/portable-charger-booking',         handler: chargerBooking },
    { method: 'get',  path: '/portable-charger-booking-list',    handler: chargerBookingList },
    { method: 'get',  path: '/portable-charger-booking-detail',  handler: chargerBookingDetail },
    { method: 'get',  path: '/portable-charger-slot-list',       handler: getPcSlotList },
    { method: 'get',  path: '/portable-charger-subscription',    handler: getPcSubscriptionList },
    { method: 'get',  path: '/portable-charger-cancel',          handler: userCancelPCBooking }, 
    { method: 'post', path: '/reschedule-portable-charger-booking', handler: reScheduleBooking },
    { method: 'post', path: '/feedback-portable-charger-booking', handler: userFeedbackPCBooking },
    { method: 'get',  path: '/portable-charger-slot-date-list',     handler: getPcSlotDateList },
    { method: 'get',  path: '/portable-charger-invoice',            handler: podInvoiceDetails },

    /* Offer Routes */
    { method: 'get', path: '/offer-list',   handler: offerList },
    { method: 'get', path: '/offer-detail', handler: offerDetail },
    { method: 'post', path: '/create-offer-history', handler: offerHistory },

    /* EV Insurance */
    { method: 'post', path: '/add-insurance',          handler: addInsurance},
    { method: 'post', path: '/insurance-list',         handler: insuranceList },
    { method: 'post', path: '/insurance-details',      handler: insuranceDetails },

    /* Payment */
    { method: 'post', path: '/payment-intent',                       handler: createIntent },
    { method: 'post', path: '/add-card',                             handler: addCardToCustomer },
    { method: 'post', path: '/remove-card',                          handler: removeCard },
    { method: 'post', path: '/list-card',                            handler: customerCardsList },
    { method: 'post', path: '/create-portable-charger-subscription', handler: createPortableChargerSubscription },
    { method: 'post', path: '/get-payment-session',                  handler: getPaymentSession },
    { method: 'post', path: '/saved-card-payment',                   handler: savedcardPayment },
    { method: 'post', path: '/get-payment-session-data',             handler: getPaymentSessionData },
    { method: 'post', path: '/get-payment-data',                     handler: getPaymentdetails },

    /* Invoice */
    { method: 'post', path: '/create-rsa-invoice',                  handler: rsaInvoice },
    { method: 'post', path: '/create-pick-drop-invoice',            handler: pickAndDropInvoice },
    { method: 'post', path: '/create-portable-charger-invoice',     handler: portableChargerInvoice },
    { method: 'post', path: '/create-scan-charge-invoice',          handler: scanChargerInvoiceNew },

    // EV Charger
    { method: 'get',  path: '/ev-charger-list',    handler: evChargerList },
    { method: 'get',  path: '/accessories-list',   handler: accessoriesList },
    { method: 'get',  path: '/ev-charger-details', handler: evchargerDetails },

    // Purchase History
    { method: 'get',  path: '/purchase-history-list',   handler: purchaseHistoryList },
    { method: 'get',  path: '/purchase-history-details', handler: purchaseHistoryDetails },
    
    // Charge Share 
    { method: 'post',  path: '/add-charge-share',     handler: addChargShare },
    { method: 'get',   path: '/charge-share-list',    handler: chargeShareList },
    { method: 'get',   path: '/charge-share-detail',  handler: chargeShareDetail },
    { method: 'get',   path: '/charge-share-for-map', handler: chargeshareForMap },
    { method: 'post',  path: '/charge-share-edit',    handler: editChargShare },
    { method: 'post',  path: '/charge-share-delete',  handler: chargeShareDelete },

    // Scan Charge — multi-community access via community_resident_map; overall limits on community_resident
    { method: 'get',   path: '/resident-communities',         handler: residentCommunities },
    { method: 'post',  path: '/start-scan-charge',            handler: chargingStart },
    { method: 'post',  path: '/stop-scan-charge',             handler: stopCharge },
    { method: 'get',   path: '/scan-charge-detail',           handler: chargingDetail },
    { method: 'get',   path: '/scan-charge-history',          handler: chargingHistory },
    { method: 'get',   path: '/scan-charge-invoice-list',     handler: scanChargeInvoices },
    { method: 'get',   path: '/scan-charge-invoice-detail',   handler: scanChargeInvoiceDetail },

    // Legacy duplicate -new routes (same handlers as above; kept commented for reference)
    // { method: 'post',  path: '/start-scan-charge-new',             handler: chargingStart },
    // { method: 'post',  path: '/stop-scan-charge-new',              handler: stopCharge },
    // { method: 'get',   path: '/scan-charge-detail-new',            handler: chargingDetail },
    // { method: 'get',   path: '/scan-charge-history-new',           handler: chargingHistory },
    // { method: 'get',   path: '/scan-charge-invoice-list-new',      handler: scanChargeInvoices },
    // { method: 'get',   path: '/scan-charge-invoice-detail-new',    handler: scanChargeInvoiceDetail },
];

// Define your upload rules in a config map
const uploadRules = {
    '/rider-profile-change'  : { folder: 'rider_profile',    fields: ['profile_image'],  maxCount: 1 },
    '/add-insurance'         : { folder: 'insurance-images', fields: ['prev_insurance', 'driving_licence', 'emirates_id'], maxCount: 6 },
    '/add-charge-share'      : { folder: 'charge-share-images',  fields: ['charger_image'],  maxCount: 1 },
    '/charge-share-edit'     : { folder: 'charge-share-images',  fields: ['charger_image'],  maxCount: 1 },  
};
authzAndAuthRoutes.forEach(({ method, path, handler }) => {
    const middlewares = []; 

    const rule = uploadRules[path];
    if (rule) {
        middlewares.push(handleFileUpload(rule.folder, rule.fields, rule.maxCount));
    } 
    middlewares.push(apiAuthorization);
    // middlewares.push(apiAuthentication);
    router[method](path, ...middlewares, handler);
});
router.post('/validate-coupon', redeemCoupon);
router.post('/auto-pay', autoPay);

// One Time routes
//router.post('/pod-invoice-history', apiAuthorization, makeBookingHistoryPOD);
//router.post('/rsa-invoice-history', apiAuthorization, makeBookingHistoryRSA);
//router.post('/valet-invoice-history', apiAuthorization, makeBookingHistoryValet);

export default router;

 