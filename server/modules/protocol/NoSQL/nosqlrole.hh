#if !defined(NOSQL_ROLE)
#error nosqlrole.hh cannot be included without NOSQL_ROLE being defined.
#endif

// *INDENT-OFF*
NOSQL_ROLE(BACKUP,                  "backup")
NOSQL_ROLE(CLUSTER_ADMIN,           "clusterAdmin")
NOSQL_ROLE(CLUSTER_MANAGER,         "clusterManager")
NOSQL_ROLE(CLUSTER_MONITOR,         "clusterMonitor")
NOSQL_ROLE(DB_ADMIN,                "dbAdmin")
NOSQL_ROLE(DB_ADMIN_ANY_DATABASE,   "dbAdminAnyDatabase")
NOSQL_ROLE(DB_OWNER,                "dbOwner")
NOSQL_ROLE(HOST_MANAGER,            "hostManager")
NOSQL_ROLE(READ_ANY_DATABASE,       "readAnyDatabase")
NOSQL_ROLE(READ,                    "read")
NOSQL_ROLE(READ_WRITE,              "readWrite")
NOSQL_ROLE(READ_WRITE_ANY_DATABASE, "readWriteAnyDatabase")
NOSQL_ROLE(RESTORE,                 "restore")
NOSQL_ROLE(ROOT,                    "root")
NOSQL_ROLE(USER_ADMIN,              "userAdmin")
NOSQL_ROLE(USER_ADMIN_ANY_DATABASE, "userAdminAnyDatabase")
// *INDENT-ON*