import { SymbolInformation_Kind } from '@c4312/scip';

export const SCIP_KIND_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(SymbolInformation_Kind)
    .filter(([key, value]) => Number.isInteger(Number(key)) && typeof value === 'string')
    .map(([key, value]) => [Number(key), value as string]),
);

export const SCIP_KIND_BY_NAME: ReadonlyMap<string, number> = new Map(
  [...SCIP_KIND_NAMES.entries()].map(([kind, name]) => [name.toLowerCase(), kind]),
);

export function scipKindName(kind: number): string {
  return SCIP_KIND_NAMES.get(kind) ?? 'Unknown';
}

// scip-query: ignore-wrapper — central SCIP kind policy shared with graph logic;
// keep enum membership named instead of inlining into SQL call-graph setup.
export function scipFunctionLikeKindNumbers(): number[] {
  return [
    SymbolInformation_Kind.Function,
    SymbolInformation_Kind.Method,
    SymbolInformation_Kind.Macro,
    SymbolInformation_Kind.Constructor,
    SymbolInformation_Kind.Getter,
    SymbolInformation_Kind.Setter,
    SymbolInformation_Kind.StaticMethod,
    SymbolInformation_Kind.SingletonMethod,
    SymbolInformation_Kind.AbstractMethod,
    SymbolInformation_Kind.ProtocolMethod,
    SymbolInformation_Kind.TraitMethod,
  ];
}

// scip-query: ignore-wrapper — central SCIP kind policy shared with graph logic;
// keep enum membership named instead of inlining into SQL call-graph setup.
export function scipTypeLikeKindNumbers(): number[] {
  return [
    SymbolInformation_Kind.Class,
    SymbolInformation_Kind.Interface,
    SymbolInformation_Kind.Struct,
    SymbolInformation_Kind.Trait,
    SymbolInformation_Kind.Type,
    SymbolInformation_Kind.TypeAlias,
    SymbolInformation_Kind.Enum,
    SymbolInformation_Kind.Union,
    SymbolInformation_Kind.Protocol,
  ];
}

// scip-query: ignore-wrapper — TLA conformance needs to distinguish runtime
// state referents from type- or action-level referents without inlining enum
// policy at every call site.
export function scipValueLikeKindNumbers(): number[] {
  return [
    SymbolInformation_Kind.Constant,
    SymbolInformation_Kind.Variable,
    SymbolInformation_Kind.Value,
    SymbolInformation_Kind.Field,
    SymbolInformation_Kind.Property,
    SymbolInformation_Kind.StaticDataMember,
    SymbolInformation_Kind.StaticField,
    SymbolInformation_Kind.StaticProperty,
    SymbolInformation_Kind.StaticVariable,
    SymbolInformation_Kind.EnumMember,
  ];
}
