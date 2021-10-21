/*
 * Copyright (c) 2021 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2025-10-11
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */

#include <maxbase/ini.hh>

#define INI_HANDLER_LINENO 1
#include "../../../inih/ini.h"

namespace maxbase
{
namespace ini
{
int ini_parse(const char* filename, IniHandler handler, void* userdata)
{
    return ::ini_parse(filename, handler, userdata);
}
}
}