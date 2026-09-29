-- =====================================================================
-- Live Update 29-09-2026
-- Changes after "Live Update 03-09-2026" (master @ b2dccc3)
-- Branch : Ajo (commits 24ded16 .. 8f9e7a5)
-- Database : plusx-node
-- Run on the live database before deploying the Ajo branch code.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. [REQUIRED] community_chargers : add live meter fields
--    Scan-charge code now reads energy / power / charger_max_speed from
--    community_chargers instead of scan_charger_data.
-- ---------------------------------------------------------------------
ALTER TABLE `plusx-node`.`community_chargers`
    ADD COLUMN `voltage`           DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `current`           DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `power`             DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `energy`            DECIMAL(12, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `pf`                DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `frequency`         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `ontime`            INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `offtime`           INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `charger_max_speed` DECIMAL(10, 2) NOT NULL DEFAULT 0 COMMENT 'Max charger speed in kW (from scan_charger_data)';


-- ---------------------------------------------------------------------
-- 2. [OPTIONAL] Backfill community_chargers from the latest
--    scan_charger_data row per charger.
--    Uncomment only if the meter feed does not already write to
--    community_chargers on live.
-- ---------------------------------------------------------------------
-- UPDATE `plusx-node`.`community_chargers` cc
-- INNER JOIN (
--     SELECT
--         scd.charger_id, scd.voltage, scd.`current`, scd.power, scd.energy,
--         scd.pf, scd.frequency, scd.ontime, scd.offtime, scd.charger_max_speed
--     FROM `plusx-node`.`scan_charger_data` scd
--     INNER JOIN (
--         SELECT charger_id, MAX(id) AS max_id
--         FROM `plusx-node`.`scan_charger_data`
--         GROUP BY charger_id
--     ) latest ON latest.charger_id = scd.charger_id AND latest.max_id = scd.id
-- ) src ON src.charger_id = cc.charger_id
-- SET
--     cc.voltage           = src.voltage,
--     cc.`current`         = src.`current`,
--     cc.power             = src.power,
--     cc.energy            = src.energy,
--     cc.pf                = src.pf,
--     cc.frequency         = src.frequency,
--     cc.ontime            = src.ontime,
--     cc.offtime           = src.offtime,
--     cc.charger_max_speed = COALESCE(src.charger_max_speed, 0);


-- ---------------------------------------------------------------------
-- 3. [REQUIRED] charger_installation_inquiry : add rider_id
--    linkChargerInstallationInquiryToRider (RiderController.js) links
--    admin-created inquiries to the rider by mobile_no.
-- ---------------------------------------------------------------------
ALTER TABLE `plusx-node`.`charger_installation_inquiry`
    ADD COLUMN `rider_id` VARCHAR(50) NULL DEFAULT NULL,
    ADD INDEX `idx_cii_rider_id` (`rider_id`),
    ADD INDEX `idx_cii_mobile_no` (`mobile_no`);


-- =====================================================================
-- REFERENCE ONLY : application query changes in code (do not run)
-- =====================================================================

-- scan_charger_data -> community_chargers
--   controller/api/ScanChargeController.js     : chargingStart, startChargingCheck, stopCharge, chargingDetail
--   controller/api/ScanChargerControllerNew.js : chargingStart, startChargingCheck, stopCharge, chargingDetail
--   controller/api/RiderController.js          : scanChargingDetail
--   controller/TestController.js               : scanChargePlugCheckCron
--
--   SELECT energy FROM `plusx-node`.`community_chargers`
--   WHERE charger_id = ? AND updated_at >= NOW() - INTERVAL 5 MINUTE LIMIT 1;
--
--   SELECT energy FROM `plusx-node`.`community_chargers` WHERE charger_id = ? LIMIT 1;
--
--   SELECT energy, power FROM `plusx-node`.`community_chargers` WHERE charger_id = ? LIMIT 1;
--
--   SELECT energy, power, charger_max_speed FROM `plusx-node`.`community_chargers` WHERE charger_id = ? LIMIT 1;
--
--   (SELECT energy FROM `plusx-node`.`community_chargers` WHERE charger_id = ? LIMIT 1) AS energy
--
--   (SELECT cc.energy FROM `plusx-node`.`community_chargers` cc WHERE cc.charger_id = b.charger_id LIMIT 1) AS current_energy

-- RiderController.js : linkChargerInstallationInquiryToRider (call in register() commented out)
--   UPDATE `plusx-node`.`charger_installation_inquiry` SET rider_id = ? WHERE mobile_no = ? AND rider_id IS NULL;

-- RiderController.js : verifyOTP
--   UPDATE `plusx-node`.`riders`
--   SET access_token = ?, status = 1, fcm_token = ?, device_name = ?,
--       added_from = CASE
--           WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl') THEN ?
--           ELSE added_from
--       END
--   WHERE rider_mobile = ? AND country_code = ?;

-- RoadAssistanceController.js : roadAssistanceList
--   Offline RSA bookings now only on the Completed tab (CM), status RO / PU / CC.
--
--   SELECT COUNT(*) AS total FROM `plusx-node`.`rsa_offline_booking`
--   WHERE rider_id = ? AND order_status IN ('RO', 'PU', 'CC');
--
--   SELECT request_id, booking_price AS price, customer_name AS name, '' AS country_code,
--          mobile_no AS contact_no, order_status, created_at, address AS pickup_address, 1 AS is_offline
--   FROM `plusx-node`.`rsa_offline_booking`
--   WHERE rider_id = ? AND order_status IN ('RO', 'PU', 'CC')
--   ORDER BY ...;

-- TestController.js : scanChargerInvoiceConfirm (Stripe webhook, booking type SCI)
--   SELECT invoice_id, rider_id FROM `plusx-node`.`scan_charger_invoice`
--   WHERE invoice_id = ? AND invoice_status = 0 LIMIT 1;
--
--   UPDATE `plusx-node`.`scan_charger_invoice`
--   SET invoice_status = 1, payment_intent_id = ?
--   WHERE invoice_id = ? AND rider_id = ?;
