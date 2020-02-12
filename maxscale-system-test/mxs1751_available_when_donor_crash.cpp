/*
 * Copyright (c) 2016 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2024-02-10
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */

#include "testconnections.h"

int main(int argc, char* argv[])
{
    TestConnections::require_galera(true);
    TestConnections test(argc, argv);

    for (int i = 0; i < 2; i++)
    {
        test.galera->stop_node(0);
        test.galera->stop_node(1);
        test.galera->start_node(1);
        test.galera->start_node(0);
        test.maxscales->wait_for_monitor(2);
    }

    return test.global_result;
}
