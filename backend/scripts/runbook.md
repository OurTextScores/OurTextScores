## Runbook

### Project Promotion


  1. Export from local:
```
  cd backend
  MONGO_URI='mongodb://ots_mongo_user:rRb57JWl2WlZ@localhost:27018/ourtextscores?authSource=admin' 
  MINIO_URL='http://localhost:9002' 
  MINIO_ACCESS_KEY='minioadmin' 
  MINIO_SECRET_KEY='minioadmin' 
  FOSSIL_PATH='/home/jhlusko/workspace/fossil_data' 


  npm run ops:project-promotion -- export --projectId prj_978d6316ee --dir /tmp/prj_978d6316ee_bundle
```
  2. Transfer bundle to prod host:

```
tar -C /tmp -czf /tmp/prj_978d6316ee.tgz prj_978d6316ee_bundle
```
 then scp/rsync to prod, extract there

  3. Import on prod:
```
  cd backend
  MONGO_URI="mongodb://<prod-mongo>/ourtextscores" \
  MINIO_URL="http://<prod-minio>:9000" \
  MINIO_ACCESS_KEY="..." \
  MINIO_SECRET_KEY="..." \
  FOSSIL_PATH="/path/to/prod/fossil_data" \
  npm run ops:project-promotion -- import --dir /tmp/prj_123_bundle
```
  4. Verify on prod:
```
  cd backend
  MONGO_URI="mongodb://<prod-mongo>/ourtextscores" \
  MINIO_URL="http://<prod-minio>:9000" \
  MINIO_ACCESS_KEY="..." \
  MINIO_SECRET_KEY="..." \
  FOSSIL_PATH="/path/to/prod/fossil_data" \
  npm run ops:project-promotion -- verify --dir /tmp/prj_123_bundle
```
