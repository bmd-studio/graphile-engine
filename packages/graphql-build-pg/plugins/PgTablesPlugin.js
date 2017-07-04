const {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLID,
  GraphQLList,
  GraphQLInputObjectType,
} = require("graphql");

const base64 = str => Buffer.from(String(str)).toString("base64");

module.exports = function PgTablesPlugin(
  builder,
  { pgInflection: inflection }
) {
  builder.hook(
    "init",
    (
      _,
      {
        getNodeIdForTypeAndIdentifiers,
        nodeIdFieldName,
        buildObjectWithHooks,
        pgSql: sql,
        pgIntrospectionResultsByKind: introspectionResultsByKind,
        getTypeByName,
        pgGqlTypeByTypeId,
        pgGqlInputTypeByTypeId,
        pg2GqlMapper,
        gql2pg,
      }
    ) => {
      const Cursor = getTypeByName("Cursor");
      introspectionResultsByKind.class.forEach(table => {
        const tablePgType = introspectionResultsByKind.type.filter(
          type =>
            type.type === "c" &&
            type.category === "C" &&
            type.namespaceId === table.namespaceId &&
            type.classId === table.id
        )[0];
        if (!tablePgType) {
          throw new Error("Could not determine the type for this table");
        }
        /*
        table =
          { kind: 'class',
            id: '6484790',
            name: 'bundle',
            description: null,
            namespaceId: '6484381',
            typeId: '6484792',
            isSelectable: true,
            isInsertable: true,
            isUpdatable: true,
            isDeletable: true }
        */
        const schema = table.namespace;
        const primaryKeyConstraint = introspectionResultsByKind.constraint
          .filter(con => con.classId === table.id)
          .filter(con => ["p"].includes(con.type))[0];
        const primaryKeys =
          primaryKeyConstraint &&
          primaryKeyConstraint.keyAttributeNums.map(
            num =>
              introspectionResultsByKind.attributeByClassIdAndNum[table.id][num]
          );
        const attributes = introspectionResultsByKind.attribute
          .filter(attr => attr.classId === table.id)
          .sort((a1, a2) => a1.num - a2.num);
        const TableType = buildObjectWithHooks(
          GraphQLObjectType,
          {
            name: inflection.tableType(table.name, schema.name),
            interfaces: () => {
              if (nodeIdFieldName && table.isSelectable) {
                return [getTypeByName("Node")];
              } else {
                return [];
              }
            },
            fields: ({ addDataGeneratorForField, Self }) => {
              const fields = {};
              if (nodeIdFieldName && table.isSelectable) {
                // Enable nodeId interface
                addDataGeneratorForField(nodeIdFieldName, () => {
                  return {
                    pgQuery: queryBuilder => {
                      queryBuilder.select(
                        sql.fragment`json_build_array(${sql.join(
                          primaryKeys.map(
                            key =>
                              sql.fragment`${queryBuilder.getTableAlias()}.${sql.identifier(
                                key.name
                              )}`
                          ),
                          ", "
                        )})`,
                        "__identifiers"
                      );
                    },
                  };
                });
                fields[nodeIdFieldName] = {
                  type: new GraphQLNonNull(GraphQLID),
                  resolve(data) {
                    return getNodeIdForTypeAndIdentifiers(
                      Self,
                      ...data.__identifiers
                    );
                  },
                };
              }
              return fields;
            },
          },
          {
            pgIntrospection: table,
            isPgRowType: table.isSelectable,
            isPgCompoundType: !table.isSelectable,
          }
        );
        const pgInputFields = {};
        const TableInputType = buildObjectWithHooks(
          GraphQLInputObjectType,
          {
            name: inflection.inputType(TableType),
          },
          {
            pgIntrospection: table,
            isPgRowType: table.isSelectable,
            isPgCompoundType: !table.isSelectable,
            pgAddSubfield(fieldName, attrName, pgType, spec) {
              pgInputFields[fieldName] = {
                name: attrName,
                type: pgType,
              };
              return spec;
            },
          }
        );

        pg2GqlMapper[tablePgType.id] = {
          map: _ => _,
          unmap: obj => {
            return sql.fragment`row(${sql.join(
              attributes.map(attr => {
                const fieldName = inflection.column(
                  attr.name,
                  table.name,
                  table.namespace.name
                );
                const pgInputField = pgInputFields[fieldName];
                const v = obj[fieldName];
                if (pgInputField && v != null) {
                  const { name, type } = pgInputField;
                  return sql.fragment`${gql2pg(v, type)}::${sql.identifier(
                    type.namespaceName,
                    type.name
                  )}`;
                } else {
                  return sql.null;
                }
              }),
              ","
            )})::${sql.identifier(
              tablePgType.namespaceName,
              tablePgType.name
            )}`;
          },
        };

        if (table.isSelectable) {
          /* const TablePatchType = */
          buildObjectWithHooks(
            GraphQLInputObjectType,
            {
              name: inflection.patchType(TableType),
            },
            {
              pgIntrospection: table,
              isPgRowType: table.isSelectable,
              isPgCompoundType: !table.isSelectable,
              isPgPatch: true,
              pgAddSubfield(fieldName, _attrName, _type, spec) {
                if (!pgInputFields[fieldName]) {
                  throw new Error(
                    "Patch and Input types share the same subfield specs currently"
                  );
                }
                return spec;
              },
            }
          );
          const EdgeType = buildObjectWithHooks(
            GraphQLObjectType,
            {
              name: inflection.edge(TableType.name),
              fields: ({ recurseDataGeneratorsForField }) => {
                recurseDataGeneratorsForField("node");
                return {
                  cursor: {
                    type: Cursor,
                    resolve(data) {
                      return (
                        data.__cursor && base64(JSON.stringify(data.__cursor))
                      );
                    },
                  },
                  node: {
                    type: new GraphQLNonNull(TableType),
                    resolve(data) {
                      return data;
                    },
                  },
                };
              },
            },
            {
              isEdgeType: true,
              isPgRowEdgeType: true,
              nodeType: TableType,
              pgIntrospection: table,
            }
          );
          const PageInfo = getTypeByName("PageInfo");
          /*const ConnectionType = */
          buildObjectWithHooks(
            GraphQLObjectType,
            {
              name: inflection.connection(TableType.name),
              fields: ({ recurseDataGeneratorsForField }) => {
                recurseDataGeneratorsForField("edges");
                recurseDataGeneratorsForField("nodes");
                recurseDataGeneratorsForField("pageInfo");
                return {
                  nodes: {
                    type: new GraphQLNonNull(new GraphQLList(TableType)),
                    resolve(data) {
                      return data.data;
                    },
                  },
                  edges: {
                    type: new GraphQLNonNull(
                      new GraphQLList(new GraphQLNonNull(EdgeType))
                    ),
                    resolve(data) {
                      return data.data;
                    },
                  },
                  pageInfo: PageInfo && {
                    type: new GraphQLNonNull(PageInfo),
                    resolve(data) {
                      return data;
                    },
                  },
                };
              },
            },
            {
              isConnectionType: true,
              isPgRowConnectionType: true,
              edgeType: EdgeType,
              nodeType: TableType,
              pgIntrospection: table,
            }
          );
        }
        pgGqlTypeByTypeId[tablePgType.id] = TableType;
        pgGqlInputTypeByTypeId[tablePgType.id] = TableInputType;
      });
      return _;
    }
  );
};
