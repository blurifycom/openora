CREATE INDEX "player_tag_tag_id_idx" ON "player_tag" USING btree ("tag_id") WHERE "player_tag"."removed_at" is null;
