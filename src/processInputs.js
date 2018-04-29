const { visit } = require('graphql/language');
const { extractName, extractArguments, typeInfo } = require('./utils');
const debug = require('debug')('graphql-super-schema:inputs');

async function reduceTransformers(
  input,
  value,
  requestConfig,
  transformers,
  config,
) {
  for (const transformer of transformers) {
    value = await transformer.function(value, transformer.args, {
      type: input,
      ...requestConfig,
      ...config,
    });
  }
  return value;
}

function createFieldTransformer(name, fields, config) {
  return async (object, requestConfig) => {
    const result = {};
    for (const [key, value] of Object.entries(object)) {
      const { transformers } = fields[key];
      result[key] = await reduceTransformers(
        fields[key],
        value,
        requestConfig,
        transformers,
        config,
      );
    }
    return result;
  };
}

function createObjectTransformer(input, config) {
  return async (object, requestConfig) => {
    return reduceTransformers(
      input,
      object,
      requestConfig,
      input.objectValidators,
      config,
    );
  };
}

function processFieldDirective(source, field, node, { transformers }) {
  const directiveName = extractName(node);

  // not our directive so return the node and move on.
  if (!transformers[directiveName]) {
    // eslint-disable-next-line
    console.warn('Unknown validator', directiveName);
    return node;
  }

  field.transformers.push({
    name: directiveName,
    function: transformers[directiveName],
    args: extractArguments(node.arguments),
  });

  // once we've consumed the directive then we can remove the node.
  return null;
}

function processInputDirective(source, input, node, { transformers }) {
  const directiveName = extractName(node);

  // not our directive so return the node and move on.
  if (!transformers[directiveName]) {
    // eslint-disable-next-line
    console.warn('Unknown validator', directiveName);
    return node;
  }

  input.objectValidators.push({
    name: directiveName,
    function: transformers[directiveName],
    args: extractArguments(node.arguments),
  });

  // once we've consumed the directive then we can remove the node.
  return null;
}

function processInput(source, doc, config) {
  const inputMapping = {};
  let inputObj = null;
  let field = null;

  const inputAST = visit(doc, {
    Document(node) {
      return node;
    },
    InputObjectTypeDefinition: {
      enter(node) {
        const name = extractName(node);
        inputObj = { name, fields: [], objectValidators: [] };
        return node;
      },
      leave(node) {
        inputObj.fields = inputObj.fields.reduce((sum, field) => {
          sum[field.name] = field;
          return sum;
        }, {});
        inputMapping[inputObj.name] = inputObj;
        debug('register type', inputObj);
        inputObj = null;
        return node;
      },
    },
    InputValueDefinition: {
      enter(node) {
        if (!inputObj) return node;
        field = {
          name: extractName(node),
          ...typeInfo(node),
          transformers: [],
        };
        return node;
      },
      leave(node) {
        if (!inputObj) return node;
        inputObj.fields.push(field);
        field = null;
        return node;
      },
    },
    Directive: {
      enter(node) {
        // only process directives when we are an input object field.
        if (!field && !inputObj) return node;
        return node;
      },
      leave(node) {
        if (field) {
          return processFieldDirective(source, field, node, config);
        }
        return processInputDirective(source, inputObj, node, config);
      },
    },
  });

  const inputs = Object.entries(inputMapping).reduce(
    (sum, [inputName, input]) => {
      // resolve any outstanding references to input types in the transformers.
      const inputFieldMap = {};
      Object.values(input.fields)
        .map(field => {
          const { type, isCustomType } = field;
          // if it's not some kind of custom input type then move on.
          if (isCustomType === false) {
            return field;
          }

          // must be both a custom type and input type for us to apply the object validation.
          const inputType = inputMapping[type];
          if (!inputType) {
            return field;
          }

          // XXX: Note how this is modified by reference. This is very intentional
          // because field transformers may reference other input field transformers which
          // have not been fully resolved yet. Once this entire loop is finished _then_
          // the validator will be ready to be called.
          debug('create nested validator', field.type, field.name);
          field.transformers.push({
            name: 'nested',
            function: createFieldTransformer(
              inputType,
              inputMapping[inputType.name].fields,
              config,
            ),
            args: {},
          });

          return field;
        })
        .reduce((sum, field) => {
          sum[field.name] = field;
          return sum;
        }, inputFieldMap);

      const objectTransformer = createObjectTransformer(input, config);
      const fieldsTransformer = createFieldTransformer(
        inputName,
        inputFieldMap,
        config,
      );

      const transformer = async (value, requestConfig) => {
        const fieldValue = await fieldsTransformer(value, requestConfig);
        return objectTransformer(fieldValue, requestConfig);
      };

      sum[inputName] = {
        ...input,
        transformer,
      };

      return sum;
    },
    {},
  );

  return [inputAST, inputs];
}

module.exports = processInput;
