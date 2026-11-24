-- Étape 6 : tableau de bord. Les rapports filtrent surtout sur la date de vente.
CREATE INDEX tickets_tenant_sold_at_idx ON tickets (tenant_id, sold_at);
CREATE INDEX tickets_line_sold_at_idx ON tickets (line_id, sold_at);
