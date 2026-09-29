CREATE TABLE IF NOT EXISTS tariff_catalog (
 id integer PRIMARY KEY CHECK(id=1), revision integer NOT NULL DEFAULT 1,
 updated_by bigint, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tariff_catalog(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS tariff_plans (
 code text PRIMARY KEY CHECK(code IN ('basic','standard','pro')),
 group_limit integer NOT NULL CHECK(group_limit>0),
 price_sum integer NOT NULL CHECK(price_sum>0), sort_order integer NOT NULL
);
INSERT INTO tariff_plans(code,group_limit,price_sum,sort_order) VALUES
 ('basic',30,20000,1),('standard',100,50000,2),('pro',300,75000,3) ON CONFLICT DO NOTHING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_plan_code text NOT NULL DEFAULT 'basic' REFERENCES tariff_plans(code);
ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_group_limit integer NOT NULL DEFAULT 30 CHECK(paid_group_limit>0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_group_limit integer CHECK(trial_group_limit>0);
UPDATE users SET trial_group_limit=30 WHERE trial_started_at IS NOT NULL AND trial_group_limit IS NULL;
ALTER TABLE promotion_enrollments ADD COLUMN IF NOT EXISTS group_limit integer NOT NULL DEFAULT 30 CHECK(group_limit>0);
ALTER TABLE tariff_events ADD COLUMN IF NOT EXISTS plan_code text REFERENCES tariff_plans(code);
ALTER TABLE tariff_events ADD COLUMN IF NOT EXISTS group_limit integer CHECK(group_limit>0);
ALTER TABLE tariff_events ADD COLUMN IF NOT EXISTS catalog_revision integer;
UPDATE tariff_events SET plan_code='basic',group_limit=30 WHERE action='activate' AND plan_code IS NULL;
