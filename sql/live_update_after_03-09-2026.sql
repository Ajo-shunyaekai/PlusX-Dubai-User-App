-- =====================================================================
-- SQL changes after "Live Update 03-09-2026" (master @ b2dccc3)
-- Branch : Ajo (commits 24ded16 .. 3b65542)
-- Run on the live database before deploying the Ajo branch code.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. [REQUIRED] community_chargers : add live meter fields
--    Commit 24ded16 / fe004e4
--    Scan-charge code now reads energy / power / charger_max_speed from
--    community_chargers instead of scan_charger_data.
-- ---------------------------------------------------------------------
ALTER TABLE community_chargers
    ADD COLUMN voltage           DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN `current`         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN power             DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN energy            DECIMAL(12, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN pf                DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN frequency         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN ontime            INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN offtime           INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN charger_max_speed DECIMAL(10, 2) NOT NULL DEFAULT 0 COMMENT 'Max charger speed in kW (from scan_charger_data)';


-- ---------------------------------------------------------------------
-- 2. [OPTIONAL] Backfill community_chargers from latest scan_charger_data
--    row per charger (was in 24ded16, removed in fe004e4).
--    Uncomment only if the meter feed does not already write to
--    community_chargers on live.
-- ---------------------------------------------------------------------
-- UPDATE community_chargers cc
-- INNER JOIN (
--     SELECT
--         scd.charger_id, scd.voltage, scd.`current`, scd.power, scd.energy,
--         scd.pf, scd.frequency, scd.ontime, scd.offtime, scd.charger_max_speed
--     FROM scan_charger_data scd
--     INNER JOIN (
--         SELECT charger_id, MAX(id) AS max_id
--         FROM scan_charger_data
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
-- 3. [VERIFY] charger_installation_inquiry.rider_id
--    Commit 114f3c9 : register() now links admin-created inquiries to the
--    rider by mobile_no. Requires a rider_id column on this table.
--    Check first; add only if missing.
-- ---------------------------------------------------------------------
-- SHOW COLUMNS FROM charger_installation_inquiry LIKE 'rider_id';
--
-- ALTER TABLE charger_installation_inquiry
--     ADD COLUMN rider_id VARCHAR(50) NULL DEFAULT NULL,
--     ADD INDEX idx_cii_rider_id (rider_id),
--     ADD INDEX idx_cii_mobile_no (mobile_no);


-- ---------------------------------------------------------------------
-- 4. [VERIFY] riders.added_from
--    Commits 3fc74e6 / 3b65542 : verifyOTP() switches added_from from
--    'Rsa Offline' / 'CI Offline' / 'Admin Offline' / 'Admin Offl'
--    to 'iOS' or 'Android'. No schema change needed; check the column
--    length ('Admin Offl' suggests it may be VARCHAR(10)).
-- ---------------------------------------------------------------------
-- SHOW COLUMNS FROM riders LIKE 'added_from';
-- SELECT added_from, COUNT(*) FROM riders GROUP BY added_from;


-- =====================================================================
-- REFERENCE ONLY : application query changes in code (do not run)
-- =====================================================================

-- [24ded16] scan_charger_data -> community_chargers (no ORDER BY id DESC)
--   controller/api/ScanChargeController.js     : chargingStart, startChargingCheck, stopCharge, chargingDetail
--   controller/api/ScanChargerControllerNew.js : chargingStart, startChargingCheck, stopCharge, chargingDetail
--   controller/api/RiderController.js          : scanChargingDetail
--   controller/TestController.js               : scanChargePlugCheckCron
--
--   SELECT energy FROM community_chargers
--   WHERE charger_id = ? AND updated_at >= NOW() - INTERVAL 5 MINUTE LIMIT 1;
--
--   SELECT energy FROM community_chargers WHERE charger_id = ? LIMIT 1;
--
--   SELECT energy, power FROM community_chargers WHERE charger_id = ? LIMIT 1;
--
--   SELECT energy, power, charger_max_speed FROM community_chargers WHERE charger_id = ? LIMIT 1;
--
--   (SELECT energy FROM community_chargers WHERE charger_id = ? LIMIT 1) AS energy
--
--   (SELECT cc.energy FROM community_chargers cc WHERE cc.charger_id = b.charger_id LIMIT 1) AS current_energy

-- [114f3c9] RiderController.js : linkChargerInstallationInquiryToRider (called in register)
--   UPDATE charger_installation_inquiry SET rider_id = ? WHERE mobile_no = ? AND rider_id IS NULL;

-- [3fc74e6 / 3b65542] RiderController.js : verifyOTP
--   UPDATE riders
--   SET access_token = ?, status = 1, fcm_token = ?, device_name = ?,
--       added_from = CASE
--           WHEN added_from IN ('Rsa Offline', 'CI Offline', 'Admin Offline', 'Admin Offl') THEN ?
--           ELSE added_from
--       END
--   WHERE rider_mobile = ? AND country_code = ?;

-- [4d91e2a] RoadAssistanceController.js : roadAssistanceList
--   Offline RSA bookings now only on the Completed tab (CM), status RO / PU / CC.
--   Offline in-process bookings removed from the Scheduled tab.
--
--   SELECT COUNT(*) AS total FROM rsa_offline_booking
--   WHERE rider_id = ? AND order_status IN ('RO', 'PU', 'CC');
--
--   SELECT request_id, booking_price AS price, customer_name AS name, '' AS country_code,
--          mobile_no AS contact_no, order_status, created_at, address AS pickup_address, 1 AS is_offline
--   FROM rsa_offline_booking
--   WHERE rider_id = ? AND order_status IN ('RO', 'PU', 'CC')
--   ORDER BY ...;
