/**
 * Fork configuration: reference kinds preserved during resolution cleanup.
 *
 * These kinds carry structural value for usages/search even when unresolved,
 * so they are never deleted during batch resolution.
 */
export const PRESERVED_UNRESOLVED_KINDS = new Set(['type_of', 'calls', 'macro_call', 'method_call']);
