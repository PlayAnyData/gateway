import { isSubschemaConfig } from '@graphql-tools/delegate';
import {
  mergeEnum,
  mergeInputType,
  mergeInterface,
  mergeScalar,
  mergeType,
  mergeUnion,
} from '@graphql-tools/merge';
import { Maybe } from '@graphql-tools/utils';
import {
  EnumTypeDefinitionNode,
  EnumTypeExtensionNode,
  getNullableType,
  GraphQLEnumType,
  GraphQLEnumValueConfigMap,
  GraphQLFieldConfig,
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfig,
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLScalarLiteralParser,
  GraphQLScalarSerializer,
  GraphQLScalarType,
  GraphQLScalarValueParser,
  GraphQLUnionType,
  InputObjectTypeDefinitionNode,
  InputObjectTypeExtensionNode,
  InterfaceTypeDefinitionNode,
  InterfaceTypeExtensionNode,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isNullableType,
  isObjectType,
  isScalarType,
  isUnionType,
  ObjectTypeDefinitionNode,
  ObjectTypeExtensionNode,
  ScalarTypeDefinitionNode,
  ScalarTypeExtensionNode,
  UnionTypeDefinitionNode,
  UnionTypeExtensionNode,
} from 'graphql';
import {
  validateFieldConsistency,
  validateInputFieldConsistency,
  validateInputObjectConsistency,
} from './mergeValidations.js';
import {
  MergeEnumValueConfigCandidate,
  MergeFieldConfigCandidate,
  MergeInputFieldConfigCandidate,
  MergeTypeCandidate,
  TypeMergingOptions,
} from './types.js';

export function mergeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLNamedType {
  const initialCandidateType = candidates[0]?.type;
  if (
    candidates.some(
      (candidate) =>
        candidate.type.constructor !== initialCandidateType?.constructor,
    )
  ) {
    throw new Error(
      `Cannot merge different type categories into common type ${typeName}.`,
    );
  }
  if (isObjectType(initialCandidateType)) {
    return mergeObjectTypeCandidates(typeName, candidates, typeMergingOptions);
  } else if (isInputObjectType(initialCandidateType)) {
    return mergeInputObjectTypeCandidates(
      typeName,
      candidates,
      typeMergingOptions,
    );
  } else if (isInterfaceType(initialCandidateType)) {
    return mergeInterfaceTypeCandidates(
      typeName,
      candidates,
      typeMergingOptions,
    );
  } else if (isUnionType(initialCandidateType)) {
    return mergeUnionTypeCandidates(typeName, candidates, typeMergingOptions);
  } else if (isEnumType(initialCandidateType)) {
    return mergeEnumTypeCandidates(typeName, candidates, typeMergingOptions);
  } else if (isScalarType(initialCandidateType)) {
    return mergeScalarTypeCandidates(typeName, candidates, typeMergingOptions);
  } else {
    // not reachable.
    throw new Error(`Type ${typeName} has unknown GraphQL type.`);
  }
}

function mergeObjectTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLObjectType<any, any> {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);

  const description = mergeTypeDescriptions(candidates, typeMergingOptions);
  const fields = fieldConfigMapFromTypeCandidates(
    candidates,
    typeMergingOptions,
  );
  const typeConfigs = candidates.map((candidate) =>
    (candidate.type as GraphQLObjectType).toConfig(),
  );
  const interfaceMap = typeConfigs
    .map((typeConfig) => typeConfig.interfaces)
    .reduce<Record<string, GraphQLInterfaceType>>((acc, interfaces) => {
      if (interfaces != null) {
        for (const iface of interfaces) {
          acc[iface.name] = iface;
        }
      }
      return acc;
    }, Object.create(null));
  const interfaces = Object.values(interfaceMap);

  const astNodes = pluck<ObjectTypeDefinitionNode>('astNode', candidates);
  const fieldAstNodes = canonicalFieldNamesForType(candidates)
    .map((fieldName) => fields[fieldName]?.astNode)
    .filter((n) => n != null);

  if (astNodes.length > 1 && fieldAstNodes.length) {
    astNodes.push({
      ...astNodes[astNodes.length - 1],
      fields: JSON.parse(JSON.stringify(fieldAstNodes)),
    } as any);
  }

  const astNode = astNodes.slice(1).reduce(
    (acc, astNode) =>
      mergeType(astNode, acc as ObjectTypeDefinitionNode, {
        ignoreFieldConflicts: true,
      }) as ObjectTypeDefinitionNode,
    astNodes[0],
  );

  const extensionASTNodes = pluck<ObjectTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  const typeConfig = {
    name: typeName,
    description,
    fields,
    interfaces,
    astNode,
    extensionASTNodes,
    extensions,
  };

  return new GraphQLObjectType(typeConfig);
}

function mergeInputObjectTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLInputObjectType {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);

  const description = mergeTypeDescriptions(candidates, typeMergingOptions);
  const fields = inputFieldConfigMapFromTypeCandidates(
    candidates,
    typeMergingOptions,
  );

  const astNodes = pluck<InputObjectTypeDefinitionNode>('astNode', candidates);
  const fieldAstNodes = canonicalFieldNamesForType(candidates)
    .map((fieldName) => fields[fieldName]?.astNode)
    .filter((n) => n != null);

  if (astNodes.length > 1 && fieldAstNodes.length) {
    astNodes.push({
      ...astNodes[astNodes.length - 1],
      fields: JSON.parse(JSON.stringify(fieldAstNodes)),
    } as any);
  }

  const astNode = astNodes.slice(1).reduce(
    (acc, astNode) =>
      mergeInputType(astNode, acc as InputObjectTypeDefinitionNode, {
        ignoreFieldConflicts: true,
      }) as InputObjectTypeDefinitionNode,
    astNodes[0],
  );

  const extensionASTNodes = pluck<InputObjectTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  const typeConfig = {
    name: typeName,
    description,
    fields,
    astNode,
    extensionASTNodes,
    extensions,
  };

  return new GraphQLInputObjectType(typeConfig);
}

function pluck<T>(
  typeProperty: string,
  candidates: Array<MergeTypeCandidate<any>>,
): Array<T> {
  return candidates
    .map((candidate: any) => candidate.type[typeProperty])
    .filter((value) => value != null) as Array<T>;
}

function mergeInterfaceTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLInterfaceType {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);

  const description = mergeTypeDescriptions(candidates, typeMergingOptions);
  const fields = fieldConfigMapFromTypeCandidates(
    candidates,
    typeMergingOptions,
  );
  const typeConfigs = candidates.map((candidate) => candidate.type.toConfig());
  const interfaceMap = typeConfigs
    .map((typeConfig) =>
      'interfaces' in typeConfig ? typeConfig.interfaces : [],
    )
    .reduce<Record<string, GraphQLInterfaceType>>((acc, interfaces) => {
      if (interfaces != null) {
        for (const iface of interfaces) {
          acc[iface.name] = iface;
        }
      }
      return acc;
    }, Object.create(null));
  const interfaces = Object.values(interfaceMap);

  const astNodes = pluck<InterfaceTypeDefinitionNode>('astNode', candidates);
  const fieldAstNodes = canonicalFieldNamesForType(candidates)
    .map((fieldName) => fields[fieldName]?.astNode)
    .filter((n) => n != null);

  if (astNodes.length > 1 && fieldAstNodes.length) {
    astNodes.push({
      ...astNodes[astNodes.length - 1],
      fields: JSON.parse(JSON.stringify(fieldAstNodes)),
    } as any);
  }

  const astNode = astNodes.slice(1).reduce(
    (acc, astNode) =>
      mergeInterface(astNode, acc as InterfaceTypeDefinitionNode, {
        ignoreFieldConflicts: true,
      }) as InterfaceTypeDefinitionNode,
    astNodes[0],
  );

  const extensionASTNodes = pluck<InterfaceTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  const typeConfig = {
    name: typeName,
    description,
    fields,
    interfaces,
    astNode,
    extensionASTNodes,
    extensions,
  };

  return new GraphQLInterfaceType(typeConfig);
}

function mergeUnionTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLUnionType {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);
  const description = mergeTypeDescriptions(candidates, typeMergingOptions);

  const typeConfigs = candidates.map((candidate) => {
    if (!isUnionType(candidate.type)) {
      throw new Error(`Expected ${candidate.type} to be a union type!`);
    }
    return candidate.type.toConfig();
  });
  const typeMap = typeConfigs.reduce<Record<string, GraphQLObjectType>>(
    (acc, typeConfig) => {
      for (const type of typeConfig.types) {
        acc[type.name] = type;
      }
      return acc;
    },
    Object.create(null),
  );
  const types = Object.values(typeMap);

  const astNodes = pluck<UnionTypeDefinitionNode>('astNode', candidates);
  const astNode = astNodes
    .slice(1)
    .reduce(
      (acc, astNode) =>
        mergeUnion(
          astNode,
          acc as UnionTypeDefinitionNode,
        ) as UnionTypeDefinitionNode,
      astNodes[0],
    );

  const extensionASTNodes = pluck<UnionTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  const typeConfig = {
    name: typeName,
    description,
    types,
    astNode,
    extensionASTNodes,
    extensions,
  };

  return new GraphQLUnionType(typeConfig);
}

function mergeEnumTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLEnumType {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);

  const description = mergeTypeDescriptions(candidates, typeMergingOptions);
  const values = enumValueConfigMapFromTypeCandidates(
    candidates,
    typeMergingOptions,
  );

  const astNodes = pluck<EnumTypeDefinitionNode>('astNode', candidates);
  const astNode = astNodes.slice(1).reduce(
    (acc, astNode) =>
      mergeEnum(astNode, acc as EnumTypeDefinitionNode, {
        consistentEnumMerge: true,
      }) as EnumTypeDefinitionNode,
    astNodes[0],
  );

  const extensionASTNodes = pluck<EnumTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  const typeConfig = {
    name: typeName,
    description,
    values,
    astNode,
    extensionASTNodes,
    extensions,
  };

  return new GraphQLEnumType(typeConfig);
}

function enumValueConfigMapFromTypeCandidates(
  candidates: Array<MergeTypeCandidate<any>>,
  typeMergingOptions?: TypeMergingOptions<any>,
): GraphQLEnumValueConfigMap {
  const enumValueConfigCandidatesMap: Record<
    string,
    Array<MergeEnumValueConfigCandidate>
  > = Object.create(null);

  for (const candidate of candidates) {
    const valueMap = (candidate.type as GraphQLEnumType).toConfig().values;
    for (const enumValue in valueMap) {
      const enumValueConfig = valueMap[enumValue];
      if (enumValueConfig) {
        const enumValueConfigCandidate = {
          enumValueConfig,
          enumValue,
          type: candidate.type as GraphQLEnumType,
          subschema: candidate.subschema,
          transformedSubschema: candidate.transformedSubschema,
        };

        if (enumValueConfigCandidatesMap[enumValue]) {
          enumValueConfigCandidatesMap[enumValue].push(
            enumValueConfigCandidate,
          );
        } else {
          enumValueConfigCandidatesMap[enumValue] = [enumValueConfigCandidate];
        }
      }
    }
  }

  const enumValueConfigMap = Object.create(null);

  for (const enumValue in enumValueConfigCandidatesMap) {
    const enumValueConfigCandidates = enumValueConfigCandidatesMap[enumValue];
    if (enumValueConfigCandidates) {
      const enumValueConfigMerger =
        typeMergingOptions?.enumValueConfigMerger ??
        defaultEnumValueConfigMerger;
      enumValueConfigMap[enumValue] = enumValueConfigMerger(
        enumValueConfigCandidates,
      );
    }
  }

  return enumValueConfigMap;
}

function defaultEnumValueConfigMerger(
  candidates: Array<MergeEnumValueConfigCandidate>,
) {
  const preferred = candidates.find(
    ({ type, transformedSubschema }) =>
      isSubschemaConfig(transformedSubschema) &&
      transformedSubschema.merge?.[type.name]?.canonical,
  );
  const lastCanonical = candidates[candidates.length - 1];
  if (!lastCanonical) {
    throw new Error('Last canonical is required');
  }
  return (preferred || lastCanonical).enumValueConfig;
}

function mergeScalarTypeCandidates<TContext = Record<string, any>>(
  typeName: string,
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLScalarType {
  candidates = orderedTypeCandidates(candidates, typeMergingOptions);

  const description = mergeTypeDescriptions(candidates, typeMergingOptions);
  const serializeFns = pluck<GraphQLScalarSerializer<any>>(
    'serialize',
    candidates,
  );
  const serialize = serializeFns[serializeFns.length - 1];

  const parseValueFns = pluck<GraphQLScalarValueParser<any>>(
    'parseValue',
    candidates,
  );
  const parseValue = parseValueFns[parseValueFns.length - 1];

  const parseLiteralFns = pluck<GraphQLScalarLiteralParser<any>>(
    'parseLiteral',
    candidates,
  );
  const parseLiteral = parseLiteralFns[parseLiteralFns.length - 1];

  const astNodes = pluck<ScalarTypeDefinitionNode>('astNode', candidates);
  const astNode = astNodes
    .slice(1)
    .reduce(
      (acc, astNode) =>
        mergeScalar(
          astNode,
          acc as ScalarTypeDefinitionNode,
        ) as ScalarTypeDefinitionNode,
      astNodes[0],
    );

  const extensionASTNodes = pluck<ScalarTypeExtensionNode>(
    'extensionASTNodes',
    candidates,
  );

  const extensions = Object.assign(
    {},
    ...pluck<Record<string, any>>('extensions', candidates),
  );

  let specifiedByURL: Maybe<string>;

  for (const candidate of candidates) {
    if ('specifiedByURL' in candidate.type && candidate.type.specifiedByURL) {
      specifiedByURL = candidate.type.specifiedByURL as any;
      break;
    }
  }

  const typeConfig = {
    name: typeName,
    description,
    serialize,
    parseValue,
    parseLiteral,
    astNode,
    extensionASTNodes,
    extensions,
    specifiedByURL,
  };

  return new GraphQLScalarType(typeConfig);
}

function orderedTypeCandidates<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): Array<MergeTypeCandidate<TContext>> {
  const typeCandidateMerger =
    typeMergingOptions?.typeCandidateMerger ?? defaultTypeCandidateMerger;
  const candidate = typeCandidateMerger(candidates);
  return candidates.filter((c) => c !== candidate).concat([candidate]);
}

function defaultTypeCandidateMerger<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
): MergeTypeCandidate<TContext> {
  const canonical: Array<MergeTypeCandidate<TContext>> = candidates.filter(
    ({ type, transformedSubschema }) =>
      isSubschemaConfig(transformedSubschema)
        ? transformedSubschema.merge?.[type.name]?.canonical
        : false,
  );

  if (canonical.length > 1) {
    if (!canonical[0]) {
      throw new Error(`First canonical is required`);
    }
    throw new Error(
      `Multiple canonical definitions for "${canonical[0].type.name}"`,
    );
  } else if (canonical.length) {
    if (!canonical[0]) {
      throw new Error(`First canonical is required`);
    }
    return canonical[0];
  }

  const lastCanonical = candidates[candidates.length - 1];

  if (!lastCanonical) {
    throw new Error(`Last canonical is required`);
  }

  return lastCanonical;
}

function mergeTypeDescriptions<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): Maybe<string> {
  const typeDescriptionsMerger =
    typeMergingOptions?.typeDescriptionsMerger ?? defaultTypeDescriptionMerger;
  return typeDescriptionsMerger(candidates);
}

function defaultTypeDescriptionMerger<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
): Maybe<string> {
  const lastCandidate = candidates[candidates.length - 1];
  return lastCandidate?.type.description;
}

function fieldConfigMapFromTypeCandidates<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLFieldConfigMap<any, any> {
  const fieldConfigCandidatesMap: Record<
    string,
    Array<MergeFieldConfigCandidate<TContext>>
  > = Object.create(null);

  for (const candidate of candidates) {
    const typeConfig = (
      candidate.type as GraphQLObjectType | GraphQLInterfaceType
    ).toConfig();
    const fieldConfigMap = typeConfig.fields;
    for (const fieldName in fieldConfigMap) {
      const fieldConfig = fieldConfigMap[fieldName];

      if (fieldConfig) {
        const fieldConfigCandidate = {
          fieldConfig,
          fieldName,
          type: candidate.type as GraphQLObjectType | GraphQLInterfaceType,
          subschema: candidate.subschema,
          transformedSubschema: candidate.transformedSubschema,
        };

        if (fieldConfigCandidatesMap[fieldName]) {
          fieldConfigCandidatesMap[fieldName].push(fieldConfigCandidate);
        } else {
          fieldConfigCandidatesMap[fieldName] = [fieldConfigCandidate];
        }
      }
    }
  }

  const fieldConfigMap = Object.create(null);

  for (const fieldName in fieldConfigCandidatesMap) {
    const fieldConfigCandidates = fieldConfigCandidatesMap[fieldName];
    if (fieldConfigCandidates) {
      fieldConfigMap[fieldName] = mergeFieldConfigs(
        fieldConfigCandidates,
        typeMergingOptions,
      );
    }
  }

  return fieldConfigMap;
}

function mergeFieldConfigs<TContext = Record<string, any>>(
  candidates: Array<MergeFieldConfigCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
) {
  const fieldConfigMerger =
    typeMergingOptions?.fieldConfigMerger ??
    getDefaultFieldConfigMerger(
      typeMergingOptions?.useNonNullableFieldOnConflict,
    );
  const finalFieldConfig = fieldConfigMerger(candidates);
  validateFieldConsistency(finalFieldConfig, candidates, typeMergingOptions);
  return finalFieldConfig;
}

export function getDefaultFieldConfigMerger(
  useNonNullableFieldOnConflict = false,
) {
  return function defaultFieldConfigMerger<TContext = Record<string, any>>(
    candidates: Array<MergeFieldConfigCandidate<TContext>>,
  ) {
    const nullables: Array<GraphQLFieldConfig<any, any>> = [];
    const nonNullables: Array<GraphQLFieldConfig<any, any>> = [];
    const canonicalByField: Array<GraphQLFieldConfig<any, any>> = [];
    const canonicalByType: Array<GraphQLFieldConfig<any, any>> = [];

    for (const {
      type,
      fieldName,
      fieldConfig,
      transformedSubschema,
    } of candidates) {
      if (!isSubschemaConfig(transformedSubschema)) continue;
      if (
        transformedSubschema.merge?.[type.name]?.fields?.[fieldName]?.canonical
      ) {
        canonicalByField.push(fieldConfig);
      } else if (transformedSubschema.merge?.[type.name]?.canonical) {
        canonicalByType.push(fieldConfig);
      }
      if (isNullableType(fieldConfig.type)) {
        nullables.push(fieldConfig);
      } else {
        nonNullables.push(fieldConfig);
      }
    }

    const nonNullableFinalField =
      nonNullables.length > 0 &&
      nullables.length > 0 &&
      useNonNullableFieldOnConflict;

    if (canonicalByField.length > 1 && candidates[0]) {
      throw new Error(
        `Multiple canonical definitions for "${candidates[0].type.name}.${candidates[0].fieldName}"`,
      );
    } else if (canonicalByField.length) {
      const finalField = canonicalByField[0];
      if (!finalField) {
        throw new Error('Final field is required');
      }
      if (nonNullableFinalField) {
        return {
          ...finalField,
          type: getNullableType(finalField.type),
        };
      }
      return finalField;
    } else if (canonicalByType.length) {
      const finalField = canonicalByType[0];
      if (!finalField) {
        throw new Error('Final field is required');
      }
      if (nonNullableFinalField) {
        return {
          ...finalField,
          type: getNullableType(finalField.type),
        };
      }
      return finalField;
    }

    const finalField = candidates[candidates.length - 1]?.fieldConfig;
    if (!finalField) {
      throw new Error('Field config is required');
    }
    if (nonNullableFinalField) {
      return {
        ...finalField,
        type: getNullableType(finalField.type),
      };
    }
    return finalField;
  };
}

function inputFieldConfigMapFromTypeCandidates<TContext = Record<string, any>>(
  candidates: Array<MergeTypeCandidate<TContext>>,
  typeMergingOptions?: TypeMergingOptions<TContext>,
): GraphQLInputFieldConfigMap {
  const inputFieldConfigCandidatesMap: Record<
    string,
    Array<MergeInputFieldConfigCandidate<TContext>>
  > = Object.create(null);
  const fieldInclusionMap: Record<string, number> = Object.create(null);

  for (const candidate of candidates) {
    const typeConfig = (candidate.type as GraphQLInputObjectType).toConfig();
    const inputFieldConfigMap = typeConfig.fields;
    for (const fieldName in inputFieldConfigMap) {
      const inputFieldConfig = inputFieldConfigMap[fieldName];
      if (inputFieldConfig == null) {
        throw new Error(`'inputFieldConfig' is required`);
      }
      fieldInclusionMap[fieldName] = fieldInclusionMap[fieldName] || 0;
      fieldInclusionMap[fieldName] += 1;

      const inputFieldConfigCandidate = {
        inputFieldConfig,
        fieldName,
        type: candidate.type as GraphQLInputObjectType,
        subschema: candidate.subschema,
        transformedSubschema: candidate.transformedSubschema,
      };

      if (inputFieldConfigCandidatesMap[fieldName]) {
        inputFieldConfigCandidatesMap[fieldName].push(
          inputFieldConfigCandidate,
        );
      } else {
        inputFieldConfigCandidatesMap[fieldName] = [inputFieldConfigCandidate];
      }
    }
  }

  validateInputObjectConsistency(
    fieldInclusionMap,
    candidates,
    typeMergingOptions,
  );

  const inputFieldConfigMap = Object.create(null);

  for (const fieldName in inputFieldConfigCandidatesMap) {
    const inputFieldConfigMerger =
      typeMergingOptions?.inputFieldConfigMerger ??
      defaultInputFieldConfigMerger;
    const inputFieldConfigCandidate = inputFieldConfigCandidatesMap[fieldName];
    if (!inputFieldConfigCandidate) {
      throw new Error('Input field config candidate is required');
    }
    inputFieldConfigMap[fieldName] = inputFieldConfigMerger(
      inputFieldConfigCandidate,
    );
    validateInputFieldConsistency(
      inputFieldConfigMap[fieldName],
      inputFieldConfigCandidate,
      typeMergingOptions,
    );
  }

  return inputFieldConfigMap;
}

function defaultInputFieldConfigMerger<TContext = Record<string, any>>(
  candidates: Array<MergeInputFieldConfigCandidate<TContext>>,
) {
  const canonicalByField: Array<GraphQLInputFieldConfig> = [];
  const canonicalByType: Array<GraphQLInputFieldConfig> = [];

  for (const {
    type,
    fieldName,
    inputFieldConfig,
    transformedSubschema,
  } of candidates) {
    if (!isSubschemaConfig(transformedSubschema)) continue;
    if (
      transformedSubschema.merge?.[type.name]?.fields?.[fieldName]?.canonical
    ) {
      canonicalByField.push(inputFieldConfig);
    } else if (transformedSubschema.merge?.[type.name]?.canonical) {
      canonicalByType.push(inputFieldConfig);
    }
  }

  if (canonicalByField.length > 1 && candidates[0]) {
    throw new Error(
      `Multiple canonical definitions for "${candidates[0].type.name}.${candidates[0].fieldName}"`,
    );
  } else if (canonicalByField.length) {
    return canonicalByField[0];
  } else if (canonicalByType.length) {
    return canonicalByType[0];
  }

  const lastCandidate = candidates[candidates.length - 1];

  if (!lastCandidate) {
    throw new Error('Last candidate is required');
  }

  return lastCandidate.inputFieldConfig;
}

function canonicalFieldNamesForType<TContext>(
  candidates: Array<MergeTypeCandidate<TContext>>,
): Array<string> {
  const canonicalFieldNames: Record<string, boolean> = Object.create(null);

  for (const { type, transformedSubschema } of candidates) {
    if (!isSubschemaConfig(transformedSubschema)) continue;
    const mergeConfig = transformedSubschema.merge?.[type.name];
    if (
      mergeConfig != null &&
      mergeConfig.fields != null &&
      !mergeConfig.canonical
    ) {
      for (const fieldName in mergeConfig.fields) {
        const mergedFieldConfig = mergeConfig.fields[fieldName];
        if (mergedFieldConfig?.canonical) {
          canonicalFieldNames[fieldName] = true;
        }
      }
    }
  }

  return Object.keys(canonicalFieldNames);
}
