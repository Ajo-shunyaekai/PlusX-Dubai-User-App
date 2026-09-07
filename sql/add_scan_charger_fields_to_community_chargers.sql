-- Add scan_charger_data fields to community_chargers

ALTER TABLE `plusx-node`.`community_chargers`
    ADD COLUMN voltage           DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN current         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN power             DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN energy            DECIMAL(12, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN pf                DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN frequency         DECIMAL(10, 3) NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN ontime            INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN offtime           INT NULL DEFAULT NULL COMMENT 'from scan_charger_data',
    ADD COLUMN charger_max_speed DECIMAL(10, 2) NOT NULL DEFAULT 0 COMMENT 'Max charger speed in kW (from scan_charger_data)';

