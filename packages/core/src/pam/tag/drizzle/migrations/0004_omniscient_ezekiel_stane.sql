CREATE UNIQUE INDEX "player_tag_active_key" ON "player_tag" USING btree ("tag_id","player_id") WHERE "player_tag"."removed_at" is null;
