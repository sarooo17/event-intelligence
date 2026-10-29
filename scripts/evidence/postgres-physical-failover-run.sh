#!/usr/bin/env bash
set -euo pipefail
if [[ "$EI_DISPOSABLE_PHYSICAL_FAILOVER_CONFIRM" != "YES_TWO_DISPOSABLE_DOCKER_POSTGRES_INSTANCES" ]]; then
  echo "Refusing physical failover without explicit disposable confirmation" >&2
  exit 2
fi
# Fixed names, hardcoded disposable test-only credentials and localhost ports.
# No Railway or production database connection ever enters this script.
network=ei-pg-ha-disposable-network
primary=ei-pg-ha-disposable-primary
standby=ei-pg-ha-disposable-standby
standbyvol=ei-pg-ha-disposable-standby-data
cleanup() {
  docker rm -f -v "$primary" "$standby" >/dev/null 2>&1 || true
  docker volume rm "$standbyvol" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
# Refuse pre-existing resources instead of adopting/killing a foreign process.
for kind in "container:$primary" "container:$standby" "volume:$standbyvol" "network:$network"; do
  IFS=: read -r type name <<< "$kind"
  if docker "$type" inspect "$name" >/dev/null 2>&1; then
    echo "Refusing existing Docker test resource $type" >&2
    exit 3
  fi
done
trap cleanup EXIT
docker network create "$network" >/dev/null
docker volume create "$standbyvol" >/dev/null
docker run -d --name "$primary" --label ei.disposable=yes \
  --network "$network" -p 127.0.0.1:25432:5432 \
  -e POSTGRES_PASSWORD=ei_disposable_primary_password \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  postgres:16 -c wal_level=replica -c max_wal_senders=10 \
  -c max_replication_slots=10 -c hot_standby=on >/dev/null
ready_primary=no
for i in $(seq 1 60); do
  if docker exec "$primary" pg_isready -U postgres >/dev/null 2>&1; then
    ready_primary=yes; break
  fi
  sleep 1
done
[[ "$ready_primary" == yes ]] || { echo "Primary PG16 not ready" >&2; exit 4; }
docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "CREATE ROLE ei_repl WITH LOGIN REPLICATION PASSWORD 'ei_disposable_replication_password';" >/dev/null
# Default postgres Docker pg_hba may omit a remote REPLICATION rule.
# Permit only disposable replication role inside the isolated test network.
docker exec "$primary" sh -ec 'echo "host replication ei_repl all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "SELECT pg_reload_conf();" >/dev/null
# Genuine physical WAL base backup, not pg_dump or independent databases.
docker run --rm --network "$network" \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$standbyvol":/var/lib/postgresql/data postgres:16 bash -ec \
  'mkdir -p "$PGDATA"; chown -R postgres:postgres /var/lib/postgresql/data; exec gosu postgres pg_basebackup -d "host=ei-pg-ha-disposable-primary port=5432 user=ei_repl password=ei_disposable_replication_password application_name=ei_standby" -D "$PGDATA" -Fp -Xs -R' >/dev/null
docker run -d --name "$standby" --label ei.disposable=yes \
  --network "$network" -p 127.0.0.1:25433:5432 \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v "$standbyvol":/var/lib/postgresql/data postgres:16 >/dev/null
ready_standby=no
for i in $(seq 1 60); do
  if docker exec "$standby" pg_isready -U postgres >/dev/null 2>&1; then
    ready_standby=yes; break
  fi
  sleep 1
done
[[ "$ready_standby" == yes ]] || { echo "Standby PG16 not ready" >&2; exit 5; }
docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "ALTER SYSTEM SET synchronous_standby_names = 'ei_standby';" >/dev/null
# Default for all NEW EI store connections as well, not only the 200 raw receipts.
docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c "ALTER SYSTEM SET synchronous_commit = 'remote_apply';" >/dev/null
docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "SELECT pg_reload_conf();" >/dev/null
synced=no
for i in $(seq 1 60); do
  state=$(docker exec -e PGPASSWORD=ei_disposable_primary_password "$primary" \
    psql -U postgres -d postgres -Atc \
    "SELECT sync_state FROM pg_stat_replication WHERE application_name='ei_standby' AND state='streaming';" || true)
  if [[ "$state" == sync ]]; then synced=yes; break; fi
  sleep 1
done
[[ "$synced" == yes ]] || { echo "No synchronous remote_apply standby" >&2; exit 6; }
export EI_PG_FAILOVER_PRIMARY_URL='postgresql://postgres:ei_disposable_primary_password@127.0.0.1:25432/postgres'
export EI_PG_FAILOVER_STANDBY_URL='postgresql://postgres:ei_disposable_primary_password@127.0.0.1:25433/postgres'
node scripts/evidence/postgres-physical-failover-drill.mjs
