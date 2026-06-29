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
