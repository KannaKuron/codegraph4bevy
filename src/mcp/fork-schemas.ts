/**
 * Fork schema parameter patches.
 *
 * Fork-specific input parameters for MCP tool schemas. These are spread
 * into the base tool definitions so that upstream changes to the core
 * parameters rarely require touching this file.
 */

import type { PropertySchema } from './tools';

// ── codegraph_search fork additions ─────────────────────────────────────

export const FORK_SEARCH_PARAMS: Record<string, PropertySchema> = {
  referencesType: {
    type: 'string',
    description: '查找引用此类型的所有符号（通过 type_of/references/returns 边）。设置后 query 仅作 fallback。按名称精确/后缀匹配，不支持正则。',
  },
  mutability: {
    type: 'string',
    description: 'referencesType 时过滤借用模式："mut"（可变借用，ResMut）、"shared"（共享借用，Res、&T）、"owning"（拥有值，返回类型）。用于区分资源的读写者。',
    enum: ['mut', 'shared', 'owning'],
  },
  impl_for: {
    type: 'string',
    description: '查找实现指定 trait/interface 的所有类型（通过 implements 边或未解析引用）。设置后 query 仅作 fallback。按名称精确/后缀匹配，不支持正则。',
  },
  path: {
    type: 'string',
    description: '限定搜索此目录下的文件（如 "src/components"）。未指定则搜索全部已索引文件。',
  },
  offset: {
    type: 'number',
    description: '跳过前 N 个结果（默认: 0）',
    default: 0,
  },
};

// ── codegraph_callers fork additions ────────────────────────────────────

export const FORK_CALLERS_PARAMS: Record<string, PropertySchema> = {
  symbols: {
    type: 'array',
    items: { type: 'string' },
    description: '批量查询：多个符号名，结果按符号分组',
  },
  kind: {
    type: 'string',
    description: 'Edge kind 过滤器。不指定时只返回 callers（calls 边）。指定后返回该类型的所有用法（含 incoming 和 outgoing）。kind="all" 仅返回该符号已有入边的种类，不含未产生边的框架关系。完整枚举值见 MCP Server Instructions。',
    enum: ['calls', 'references', 'type_of', 'instantiates', 'contains', 'pattern_match', 'all', 'bevy:runs_in', 'bevy:on_enter', 'bevy:on_exit', 'bevy:on_transition', 'bevy:registers_system', 'bevy:registers_resource', 'bevy:registers_message', 'bevy:registers_state', 'bevy:registers_observer', 'bevy:contains_plugin', 'bevy:configures_set', 'bevy:registers_type', 'bevy:registers_non_send'],
  },
  mutability: {
    type: 'string',
    description: '配合 kind="type_of" 过滤借用模式："mut"（可变借用，ResMut、&mut）、"shared"（共享借用，Res、&T）、"owning"（拥有值，返回类型）。用于区分类型的读写者。',
    enum: ['mut', 'shared', 'owning'],
  },
  include_external: {
    type: 'boolean',
    description: '包含对当前索引中无定义节点的符号的引用。即第三方依赖、标准库、框架 API 等在项目中没有源码的符号。默认: false。',
    default: false,
  },
};

// ── codegraph_callees fork additions ────────────────────────────────────

export const FORK_CALLEES_PARAMS: Record<string, PropertySchema> = {
  include_external: {
    type: 'boolean',
    description: '包含对当前索引中无定义节点的符号的调用。即第三方依赖、标准库、框架 API、宏等在项目中没有源码的符号。默认: true。设为 false 只显示项目内有定义节点的被调用者。',
    default: true,
  },
};

// ── codegraph_impact fork additions ─────────────────────────────────────

export const FORK_IMPACT_PARAMS: Record<string, PropertySchema> = {
  symbols: {
    type: 'array',
    items: { type: 'string' },
    description: '批量查询：多个符号名，结果按符号分组',
  },
};
