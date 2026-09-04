-- Add scan_charger_data fields to community_chargers

ALTER TABLE community_chargers
    ADD COLUMN voltage           DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN current         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN power             DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN energy            DECIMAL(12, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN pf                DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN frequency         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN ontime            INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN offtime           INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN charger_max_speed DECIMAL(10, 2) NOT NULL DEFAULT 0 COMMENT 'Max charger speed in kW (from scan_charger_data)';

-- Backfill from latest scan_charger_data row per charger
UPDATE community_chargers cc
INNER JOIN (
    SELECT
        scd.charger_id,
        scd.voltage,
        scd.current,
        scd.power,
        scd.energy,
        scd.pf,
        scd.frequency,
        scd.ontime,
        scd.offtime,
        scd.charger_max_speed
    FROM scan_charger_data scd
    INNER JOIN (
        SELECT charger_id, MAX(id) AS max_id
        FROM scan_charger_data
        GROUP BY charger_id
    ) latest ON latest.charger_id = scd.charger_id AND latest.max_id = scd.id
) src ON src.charger_id = cc.charger_id
SET
    cc.voltage           = src.voltage,
    cc.`current`         = src.`current`,
    cc.power             = src.power,
    cc.energy            = src.energy,
    cc.pf                = src.pf,
    cc.frequency         = src.frequency,
    cc.ontime            = src.ontime,
    cc.offtime           = src.offtime,
    cc.charger_max_speed = COALESCE(src.charger_max_speed, 0);
