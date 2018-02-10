//@flow
import type {
  DocumentNode,
  FieldDefinitionNode,
  TypeNode,
  InputValueDefinitionNode,
} from 'graphql';
import { camel, pascal } from 'change-case';
import {
  get,
  mapValues,
  isPlainObject,
  isBoolean,
  isString,
  isFunction,
  isArray,
} from 'lodash';
import AuthorizationError from './errors/AuthorizationError';
import { mapPromiseValues, joinPropertyPaths } from './utils';
import getTypeName from './getTypeName';
import resolveTypeDefs from './resolveTypeDefs';
import Authorizer from './Authorizer';
import type {
  AuthResult,
  AuthContext,
  QueryInputs,
  User,
  QueryRootData,
  QueryFunction,
  WrappedQueryFunction,
  Prisma,
  WithAuthorizationOptions,
} from './types';

const summarizeAuthResult = (authResult: AuthResult) => {
  const traverse = (sum, level) => {
    if (isBoolean(level)) {
      return sum && level;
    }
    return Object.values(level).reduce(traverse, sum);
  };
  return traverse(true, authResult);
};

// TODO: memoize
const getQueryField = (
  typeDefs: DocumentNode,
  rootField: string,
  queryFieldName: string,
): FieldDefinitionNode => {
  const root = get(typeDefs, 'definitions', []).find(
    def => def.name.value === rootField,
  );
  return get(root, 'fields', []).find(
    field => field.name.value === queryFieldName,
  );
};

const getInputTypesForQuery = (
  typeDefs: DocumentNode,
  rootField: string,
  queryFieldName: string,
): { [string]: string } => {
  const field = getQueryField(typeDefs, rootField, queryFieldName);
  return (field.arguments || []).reduce(
    (map: { [string]: string }, arg: InputValueDefinitionNode) => {
      const inputName = arg.name.value;
      const typeName = getTypeName(arg.type);
      return {
        ...map,
        [inputName]: typeName,
      };
    },
    {},
  );
};

const getResponseTypeForQuery = (
  typeDefs: DocumentNode,
  rootField: string,
  queryFieldName: string,
): string => {
  const field = getQueryField(typeDefs, rootField, queryFieldName);
  return getTypeName(field.type);
};

const createAuthError = (result: AuthResult): AuthorizationError => {
  return new AuthorizationError(
    `Detailed access result: ${JSON.stringify(result)}`,
  );
};

export default (
  rootAuthMapping: AuthMapping,
  typeDefs: DocumentNode | string,
  prisma: Prisma,
  options: WithAuthorizationOptions,
) => (user: User) => {
  const resolvedTypeDefs: DocumentNode = resolveTypeDefs(typeDefs);

  const authorizer = new Authorizer(rootAuthMapping);

  const wrapQuery = (
    queryFunction: QueryFunction,
    rootType: 'Query' | 'Mutation',
    queryName,
  ): WrappedQueryFunction => {
    const isRead = rootType === 'Query';

    return async (inputs: ?QueryInputs, info: string, ctx: {}) => {
      const context: AuthContext = {
        user,
        graphqlContext: ctx,
        prisma,
      };

      const inputTypes = getInputTypesForQuery(
        resolvedTypeDefs,
        rootType,
        queryName,
      );
      const responseType = getResponseTypeForQuery(
        resolvedTypeDefs,
        rootType,
        queryName,
      );

      const rootData: QueryRootData = {
        rootFieldName: queryName,
        rootTypeName: pascal(rootType),
        inputs,
      };

      /**
       * PHASE 1: Validate inputs against `write` rules
       * (mutations only)
       */
      if (!isRead) {
        const validateInputs = async (): Promise<AuthResult> =>
          mapPromiseValues(
            mapValues(inputs, (value, key) =>
              authorizer.authorize({
                typeName: inputTypes[key],
                authType: 'write',
                data: value,
                context,
                rootData,
              }),
            ),
          );

        const inputValidationResult = await validateInputs();
        const areInputsValid = summarizeAuthResult(inputValidationResult);

        if (!areInputsValid) {
          throw createAuthError(inputValidationResult);
        }
      }

      /**
       * PHASE 2: Run query and get result
       */
      const queryResponse = await queryFunction(inputs, info);

      /**
       * PHASE 3: Validate response against `read` rules
       * (mutations and queries)
       */
      const validateResponse = async (): Promise<AuthResult> =>
        authorizer.authorize({
          typeName: responseType,
          authType: 'read',
          data: queryResponse,
          context,
          rootData,
        });

      const responseValidationResult = await validateResponse();
      const isResponseValid = summarizeAuthResult(responseValidationResult);

      if (!isResponseValid) {
        throw createAuthError(responseValidationResult);
      }

      return queryResponse;
    };
  };

  const query = mapValues(prisma.query, (fn, key) =>
    wrapQuery(fn.bind(prisma), 'Query', key),
  );
  const mutation = mapValues(prisma.mutation, (fn, key) =>
    wrapQuery(fn.bind(prisma), 'Mutation', key),
  );

  return {
    query,
    mutation,
    exists: prisma.exists.bind(prisma),
    request: prisma.request.bind(prisma),
  };
};
