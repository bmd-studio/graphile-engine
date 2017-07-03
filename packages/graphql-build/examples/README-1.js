// ⚠ NOTE: If running this outside the repository, please replace the contents
// of the require brackets
const { buildSchema, defaultPlugins } = require(/*"graphql-build"*/ "..");
// or import { buildSchema, defaultPlugins } from 'graphql-build';
const { graphql, GraphQLInt } = require("graphql");

// Create a simple plugin that adds a random field to every GraphQLObject
function MyRandomFieldPlugin(
  builder,
  { myDefaultMin = 1, myDefaultMax = 100 }
) {
  builder.hook("GraphQLObjectType:fields", (fields, { extend }) => {
    return extend(fields, {
      random: {
        type: GraphQLInt,
        args: {
          sides: {
            type: GraphQLInt,
          },
        },
        resolve(_, { sides = myDefaultMax }) {
          return (
            Math.floor(Math.random() * (sides - myDefaultMin)) + myDefaultMin
          );
        },
      },
    });
  });
}

(async function() {
  // Create our GraphQL schema by applying all the plugins
  const schema = await buildSchema([...defaultPlugins, MyRandomFieldPlugin], {
    // ... options
    myDefaultMin: 1,
    myDefaultMax: 6,
  });

  // Run our query
  const result = await graphql(schema, `query { random }`, null, {});
  console.log(result); // { data: { random: 4 } }
})().catch(e => {
  console.error(e);
  process.exit(1);
});