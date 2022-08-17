/*
 * Copyright (c) 2020 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2026-08-08
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */

import PageWrapper from './PageWrapper'
import SelectDropdown from './SelectDropdown'
import DataTable from './DataTable'
import Dialogs from './Dialogs'
import IconSpriteSheet from './IconSpriteSheet'
import OutlinedOverviewCard from './OutlinedOverviewCard'
import Collapse from './Collapse'

import Charts from './Charts'
import GlobalSearch from './GlobalSearch'
import CreateResource from './CreateResource'

import DetailsPage from './DetailsPage'
import Parameters from './Parameters'
import SplitPane from './SplitPane'
import MTreeVIew from './MTreeView'
import VirtualScrollTable from './VirtualScrollTable'
import TruncateString from './TruncateString'
import SubMenu from './SubMenu'
import FilterList from './FilterList'
import RepTooltip from './RepTooltip'
import RefreshRate from './RefreshRate'
import SessionsTable from './SessionsTable'
import MonitorPageHeader from './MonitorPageHeader'
import DurationDropdown from './DurationDropdown'

export default {
    'page-wrapper': PageWrapper,
    'global-search': GlobalSearch,
    'create-resource': CreateResource,
    ...Dialogs,
    'select-dropdown': SelectDropdown,
    'data-table': DataTable,
    'icon-sprite-sheet': IconSpriteSheet,
    'outlined-overview-card': OutlinedOverviewCard,
    collapse: Collapse,
    ...Parameters,
    ...Charts,
    ...DetailsPage,
    'split-pane': SplitPane,
    'm-treeview': MTreeVIew,
    'virtual-scroll-table': VirtualScrollTable,
    'truncate-string': TruncateString,
    'sub-menu': SubMenu,
    'filter-list': FilterList,
    'rep-tooltip': RepTooltip,
    'refresh-rate': RefreshRate,
    'sessions-table': SessionsTable,
    'monitor-page-header': MonitorPageHeader,
    'duration-dropdown': DurationDropdown,
}