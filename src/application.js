/*
Copyright 2020 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/
(function() {
"use strict";


/**********************************************************************************
 * 
 * SDK "application" object
 * https://docs.adobe.com/content/help/en/campaign-classic/technicalresources/api/c-Application.html
 * 
 *********************************************************************************/
const { DomException, XPath } = require('./domUtil.js');
const XtkCaster = require('./xtkCaster.js').XtkCaster;
const EntityAccessor = require('./entityAccessor.js').EntityAccessor;

const PACKAGE_STATUS = { "never": 0, "always": 1, "default": 2, "preCreate": 3 };

/**
 * @namespace Campaign
 */

// ========================================================================================
// Helper functions
// ========================================================================================

// Determine if a name is an attribute name, i.e. if it starts with the "@" character
const isAttributeName = function(name) { return name.length > 0 && name[0] == '@'; };


/**
  * Creates a schema object from an XML representation
  * This function is not intended to be used publicly.
  * 
  * @private
  * @param {DOMElement|DOMDocument} xml the XML document or element representing the schema
  * @returns {XtkSchema} a schema object
  * @see {@link XtkSchema}
  * @memberof Campaign
  */
 function newSchema(xml, application) {
    if (xml.nodeType == 9) xml = xml.documentElement;       // Document -> element
    var schema = new XtkSchema(application, xml);
    return schema;
}

// Propagate implicit values
// Name -> Label -> Desc -> HelpText
function propagateImplicitValues(xtkDesc, labelOnly) {
    if (!xtkDesc.label) {
        if (xtkDesc.isAttribute) xtkDesc.label = xtkDesc.name.substring(1); // without @
        else xtkDesc.label = xtkDesc.name;
        // Force first letter as uppercase
        xtkDesc.label = xtkDesc.label.substring(0, 1).toUpperCase() + xtkDesc.label.substring(1);
    }
    if (!labelOnly && !xtkDesc.description) xtkDesc.description = xtkDesc.label;
}

// ========================================================================================
// Schema Cache
// ========================================================================================
class SchemaCache {
    constructor(client) {
        this._client = client;
        this._schemas = {};
    }
    async getSchema(schemaId) {
        let schema = this._schemas[schemaId];
        if (schema === undefined) {
            schema = await this._client.application._getSchema(schemaId);
            if (!schema) schema = null; // null = not found
        this._schemas[schemaId] = schema;
        }
        return schema;
    }
}

// ========================================================================================
// Keys
// ========================================================================================

/**
 * A key in a schema
 * 
 * @private
 * @class
 * @constructor
 * @param {Campaign.XtkSchema} schema
 * @param {} xml
 * @param {Campaign.XtkSchemaNode} schemaNode
 * @memberof Campaign
 */
class XtkSchemaKey {

    constructor(schema, xml, schemaNode) {
        this.schema = schema;
        this.name = EntityAccessor.getAttributeAsString(xml, "name");
        this.label = EntityAccessor.getAttributeAsString(xml, "label");
        this.description = EntityAccessor.getAttributeAsString(xml, "desc");
        this.isInternal = EntityAccessor.getAttributeAsBoolean(xml, "internal");
        this.allowEmptyPart = EntityAccessor.getAttributeAsString(xml, "allowEmptyPart");
        this.fields = {};

        for (var child of EntityAccessor.getChildElements(xml, "keyfield")) {
            const xpath = EntityAccessor.getAttributeAsString(child, "xpath");
            if (xpath == "") throw new DomException(`Cannot create XtkSchemaKey for key '${this.name}': keyfield does not have an xpath attribute`);
            const field = schemaNode.findNode(xpath);
            this.fields[field.name] = field;
        }
    }

}

/**
 * A join in a XtkSchemaNode link type
 *
 * @private
 * @class
 * @constructor
 * @param {} xml
 * @memberof Campaign
 */
 class XtkJoin {

    constructor(xml) {
        this.src = EntityAccessor.getAttributeAsString(xml, "xpath-src");
        this.dst = EntityAccessor.getAttributeAsString(xml, "xpath-dst");
    }
}
// ========================================================================================
// Schema nodes
// ========================================================================================

/**
 * A Schema Node (CXtkNodeDef). Schemas are a hierarchy of nodes. The top-level node (i.e. the
 * schema itself is also a node). The "root" node is the first child node having the same name
 * as the schema itself
 * 
 * @private
 * @class
 * @constructor
 * @memberof Campaign
 */
class XtkSchemaNode {

    constructor() {
    }
    
    /**
     * Initialize a schema node recursively
     * @param {Campaign.XtkSchema} schema The schema this node belongs to
     * @param {XML.XtkObject} xml The XML or JSON definition of the schema node
     * @param {Campaign.XtkSchemaNode} parentNode the parent node, can be undefined for the schema top level node (the schema itself)
     * @param {boolean} isAttribute indicates whether the node is an attribute node or an element node
     */
    init(schema, xml, parentNode, isAttribute) {

        /**
         * The schema the node belongs to
         * @type {XtkSchema}
         */
        this.schema = schema;

        /**
         * Returns a string of characters which provides the data policy of the current node.
         * @type {string}
         */
         this.dataPolicy = EntityAccessor.getAttributeAsString(xml, "dataPolicy");

        /**
         * Returns a string of characters which specifies the editing type of the current node.
         * @type {string}
         */
         this.editType = EntityAccessor.getAttributeAsString(xml, "editType");

        /**
         * Only on the root node, returns a string which contains the folder template(s). On the other nodes, it returns undefined.
         * @type {string}
         */
        this.folderModel = EntityAccessor.getAttributeAsString(xml, "folderModel");

        /**
         * The parent node
         * @type {XtkSchemaNode}
         */
        this.parent = parentNode;

        /**
         * Indicates if the node is an attribute or not (element or schema itself)
         * @type {boolean}
         */
        this.isAttribute = isAttribute;

        /**
         * The attribute or the node name (with the "@" sign for attributes)
         * @type {string}
         */
        this.name = (this.isAttribute ? "@" : "") + EntityAccessor.getAttributeAsString(xml, "name");

        /**
         * A human friendly name for the node. If the node is the schema node, the label will be in the plural form and "labelSingular"
         * should be used for the singular form
         * @type {string}
         */
        this.label = EntityAccessor.getAttributeAsString(xml, "label");

        /**
         * A long description of the node
         * @type {string}
         */
        this.description = EntityAccessor.getAttributeAsString(xml, "desc");

        /**
         * An optional image for the node
         * @type {string}
         */
        this.img = EntityAccessor.getAttributeAsString(xml, "img");
        this.image = this.img;

        /**
         * Returns the name of the image of the current node in the form of a string of characters.
         * @type {string}
         */
         this.enumerationImage = EntityAccessor.getAttributeAsString(xml, "enumImage");

        /**
         * The node type
         * @type {string}
         */
        this.type = EntityAccessor.getAttributeAsString(xml, "type");
        if (!this.type && isAttribute) this.type = "string";

        /**
         * The node target
         * @type {string}
         */
        this.target = EntityAccessor.getAttributeAsString(xml, "target");

         /**
         * The node integrity
         * @type {string}
         */
        this.integrity = EntityAccessor.getAttributeAsString(xml, "integrity");

         /**
         * The node data length (applicable for string-types only)
         * @type {number}
         */
        this.length = EntityAccessor.getAttributeAsLong(xml, "length");
        this.size = this.length;

        /**
         * The enum of the node
         * @type {string}
         */
         this.enum = EntityAccessor.getAttributeAsString(xml, "enum");

        /**
         * Returns a string of characters which is the name of the user enumeration used by the current node.
         * @type {string}
         */
         this.userEnumeration = EntityAccessor.getAttributeAsString(xml, "userEnum");

        /**
         * Returns a boolean which indicates whether the value of the current node is linked to a user enumeration.
         * @type {boolean}
         */
        this.hasUserEnumeration = !!this.userEnumeration;

        /**
         * "ref" attribute of the node, which references another node
         * @type {string}
         */
        this.ref = EntityAccessor.getAttributeAsString(xml, "ref");
        /**
         * Has an unlimited number of children of the same type
         * @type {boolean}
         */
        this.unbound = EntityAccessor.getAttributeAsBoolean(xml, "unbound");
        this.isCollection = this.unbound;

        /**
         * is mapped as a xml
         * @type {boolean}
         */
        this.isMappedAsXML = EntityAccessor.getAttributeAsBoolean(xml, "xml");
        /**
         * is an advanced node
         * @type {boolean}
         */
        this.isAdvanced = EntityAccessor.getAttributeAsBoolean(xml, "advanced");
        /**
         * Children of the node. This is a object whose key are the names of the children nodes (without the "@"
         * character for attributes) 
         * @type {Object.<string, Campaign.XtkSchemaNode>}
         */
         this.children = {};

        /**
         * Count the children of a node
         * @type {number}
         */
        this.childrenCount = 0;

        /**
         * Indicates if the node is the root node, i.e. the first child node of the schema, whose name is the same as the schema name
         * @type {boolean}
         */
        this.isRoot = this.parent && !this.parent.parent && this.parent.name == this.name;

        /**
         * Schema root elements may have a list of keys. This is a dictionary whose names are the key names and values the keys
         * @type {Object<string, XtkSchemaKey>}
         */
         this.keys = {};

        /**
         * The full path of the node
         * @type {string}
         */
        this.nodePath = this._getNodePath(true)._path;

        /**
         * Element of type "link" has an array of XtkJoin
         * @type {XtkJoin[]}
         */
        this.joins = [];
        for (var child of EntityAccessor.getChildElements(xml, "join")) {
            this.joins.push(new XtkJoin(child));
        }

        /**
         * Returns a boolean which indicates whether the current node is ordinary.
         * @type {boolean}
         */
         this.isAnyType = this.type === "ANY";

        /**
         * Returns a boolean which indicates whether the node is a link.
         * @type {boolean}
         */
         this.isLink = this.type === "link";

        /**
         * Returns a boolean which indicates whether the value of the current node is linked to an enumeration.
         * @type {boolean}
         */
         this.hasEnumeration = this.enum !== "";

        /**
         * Returns a boolean which indicates whether the current node is linked to an SQL table.
         * @type {boolean}
         */
         this.hasSQLTable = this.sqlTable !== '';

         /**
          * The SQL name of the field. The property is an empty string if the object isn't an SQL type field.
          * @type {string}
          */
        this.SQLName = EntityAccessor.getAttributeAsString(xml, "sqlname");

         /**
          * The SQL name of the table. The property is an empty string if the object isn't the main element or if schema mapping isn't of SQL type.
          * @type {string}
          */
        this.SQLTable = EntityAccessor.getAttributeAsString(xml, "sqltable");

        /**
         * Returns a boolean indicating whether the table is a temporary table. The table will not be created during database creation.
         * @type {boolean}
         */
         this.isTemporaryTable = EntityAccessor.getAttributeAsBoolean(xml, "temporaryTable");

        /**
         * Returns a boolean which indicates whether the current node is a logical sub-division of the schema.
         * @type {boolean}
         */
        // An element has no real value if its type is empty
        this.isElementOnly = this.type === "";

        /**
         * Returns a boolean. If the value added is vrai, during record deduplication, the default value (defined in defaultValue) is automatically reapplied during recording.
         * @type {boolean}
         */
        this.isDefaultOnDuplicate = EntityAccessor.getAttributeAsBoolean(xml, "defOnDuplicate");

        /**
         * True if the node is a link and if the join is external.
         * @type {boolean}
         */
         this.isExternalJoin = EntityAccessor.getAttributeAsBoolean(xml, "externalJoin");

        /**
         * Returns a boolean which indicates whether the current node is mapped by a Memo.
         * @type {boolean}
         */
         this.isMemo = this.type === "memo" || this.type === "CDATA";

        /**
         * Returns a boolean which indicates whether the current node is mapped by a MemoData.
         * @type {boolean}
         */
         this.isMemoData = this.isMemo && this.name === 'data';

        /**
         * Returns a boolean which indicates whether the current node is a BLOB.
         * @type {boolean}
         */
         this.isBlob = this.type === "blob";

        /**
         * Returns a boolean which indicates whether the current node is mapped from CDATA type XML.
         * @type {boolean}
         */
         this.isCDATA = this.type === "CDATA";

        /**
         * Returns a boolean which indicates whether or not the current node can take the null value into account.
         * @type {boolean}
         */
        const notNull = EntityAccessor.getAttributeAsString(xml, "notNull");
        const sqlDefault = EntityAccessor.getAttributeAsString(xml, "sqlDefault");
        const notNullOverriden = notNull || sqlDefault === "NULL"
        this.isNotNull = notNullOverriden ? XtkCaster.asBoolean(notNull) : this.type === "int64" || this.type === "short" ||
            this.type === "long" || this.type === "byte" || this.type === "float" || this.type === "double" ||
            this.type === "money" || this.type === "percent" || this.type === "time" || this.type === "boolean";

        /**
         * Returns a boolean which indicates whether or not the value of the current node is mandatory.
         * @type {boolean}
         */
        this.isRequired = EntityAccessor.getAttributeAsBoolean(xml, "required");

        /**
         * Returns a boolean which indicates whether the current node is mapped in SQL.
         * @type {boolean}
         */
         this.isSQL = !!this.SQLName || !!this.SQLTable || (this.isLink && this.schema.mappingType === 'sql' && !this.isMappedAsXML);

         /**
          * The SQL name of the field. The property is an empty string if the object isn't an SQL type field.
          * @type {string}
          */
        this.PKSequence = EntityAccessor.getAttributeAsString(xml, "pkSequence");

         /**
          * Name of the reverse link in the target schema
          * @type {string}
          */
        this.revLink = EntityAccessor.getAttributeAsString(xml, "revLink");

        /**
         * Returns a boolean which indicates whether the value of the current node is the result of a calculation.
         * @type {boolean}
         */
         this.isCalculated = false;

        /**
          * Expression associated with the node
          * @type {string}
          */
         this.expr = EntityAccessor.getAttributeAsString(xml, "expr");
        if (this.expr) this.isCalculated = true;

        /**
         * Returns a boolean which indicates whether the value of the current node is incremented automatically.
         * @type {boolean}
         */
         this.isAutoIncrement = EntityAccessor.getAttributeAsBoolean(xml, "autoIncrement");

        /**
         * Returns a boolean which indicates whether the current node is a primary key.
         * @type {boolean}
         */
        this.isAutoPK = EntityAccessor.getAttributeAsBoolean(xml, "autopk");

        /**
         * Returns a boolean which indicates whether the current node is an automatic UUID
         * @type {boolean}
         */
        this.isAutoUUID = EntityAccessor.getAttributeAsBoolean(xml, "autouuid");

        /**
         * Returns a boolean which indicates whether the schema is a staging schema
         * @type {boolean}
         */
        this.isAutoStg = EntityAccessor.getAttributeAsBoolean(xml, "autoStg");

        /**
         * Returns a string that gives the package status.
         * @type {"never" | "always" | "default" | "preCreate"}
         */
        this.packageStatusString = EntityAccessor.getAttributeAsString(xml, "pkgStatus");
        
        /**
         * Returns a number that gives the package status.
         * @type {0 | 1 | 2 | 3}
         */
        this.packageStatus = PACKAGE_STATUS[this.packageStatusString];

         // Children (elements and attributes)
        const childNodes = [];
        for (const child of EntityAccessor.getChildElements(xml, "attribute")) {
            const node = new XtkSchemaNode();
            node.init(schema, child, this, true);
            childNodes.push(node);
        }
        for (const child of EntityAccessor.getChildElements(xml, "element")) {
            const node = new XtkSchemaNode();
            node.init(schema, child, this, false);
            childNodes.push(node);
        }
        for (const childNode of childNodes) {
            if (this.children[childNode.name]) {
                // already a child with the name => there's a problem with the schema
                throw new DomException(`Failed to create schema node '${childNode.name}': there's a already a node with this name`);
            }
            this.children[childNode.name] = childNode;
            this.childrenCount = this.childrenCount + 1;
        }

        // Keys (after elements and attributes have been found)
        for (const child of EntityAccessor.getChildElements(xml, "key")) {
            const key = new XtkSchemaKey(schema, child, this);
            this.keys[key.name] = key;
        }

        // Propagate implicit values
        // Name -> Label -> Desc -> HelpText
        propagateImplicitValues(this);
    }

    /**
     * Does the node have a child with the given name?
     * 
     * @param {string} name the child name, without the "@" character for attributes
     * @returns {boolean} a boolean indicating whether the node contains a child with the given name
     */
     hasChild(name) {
        var child = this.children[name];
        if (child) return true;
        // TODO: handle ref target
    //    if (this.hasRefTarget())
    //        return this.refTarget().hasChild(name);
        return false;
    }

    /**
     * Indicates whether the current node has an unlimited number of children of the same type.
     *
     * @returns {boolean} a boolean indicating whether the node contains a child with the given name
     */
    isUnbound() {
        return this.unbound;
    }

    /**
     * Computes the path of a node
     * 
     * @private
     * @param {boolean} absolute indicates whether to compute an absolute path or a relative path (default)
     * @returns {string} the node path
     */
    _getNodePath(absolute) {
        if (absolute === undefined) absolute = true;
        var path = !this.parent ? this.name : "";
        var schemaName = this.schema.name;
        var node = this;
        while (node && node.parent) {
            if (path != "") path = `/${path}`;
            if (node.parent.parent || node.name != schemaName)
                path = `${node.name}${path}`;
            node = node.parent;
        }
        if (absolute) {
            if (path == "") path = "/";
            else if (!path.startsWith("/")) path = `/${path}`;
        }
        else {
            if (path.startsWith("/")) path = path.substring(1);
        }
        return new XPath(path);
    }


    /**
     * Returns an instance of XtkSchemaNode or null if the node doesn't exist and the mustExist parameter is set to false.
     *
     * @param {XML.XPath|string} path XPath represents the name of the node to be searched
     * @param {boolean} strict indicates whether (strict to false) or not, when the name of the last item in the path does not exist as is, it should be searched for as an attribute or an element. By default to true.
     * @param {boolean} mustExist indicates whether an exception must be raised if the node does not exist. true by default
     * @returns Returns a XtkSchemaNode instance if the node can be found, or null if the mustExist parameter is set to false.
     * @throws {Error} if the request cannot be find (when mustExist is set)
    */
    findNode(path, strict, mustExist) {
        if (strict === undefined) strict = true;
        if (mustExist === undefined) mustExist = true;
        if (typeof path == "string")
            path = new XPath(path);

        // Find the starting node
        var node = this;
        if (path.isEmpty() || path.isAbsolute()) {
            node = this.schema.root;
            if (!node)
                throw new DomException(`Cannot find node '${path}' in node ${this.name} : schema ${this.schema.name} does not have a root node`);
            path = path.getRelativePath();
        }

        // Special case for current path "."
        if (path.isSelf())
            return this;

        const elements = path.getElements();
        while (node && elements.length > 0) {
            const element = elements.shift();
            var name = element.asString();

            // TODO: if the path is a collection path, ignore the collection index
            // TODO: handle ref elements (consider the ref target instead)
            // TODO: Handle link between schemas
            // TODO: Handle any type
            
            if (!strict && elements.length == 0 && (!node.children[name] || !isAttributeName(name))) {
                // name is the final part of the path and the associated definition
                // does not exists. Since strict is set to false we check if the
                // alternate name exists (element name for an attribute or attribute
                // name for an element).
                var found = node.children[name];
                if (!found && isAttributeName(name)) found = node.children[name.substring(1)];
                if (!found && !isAttributeName(name)) found = node.children[`@${name}`];
                if (found) name = found.name;
            }

            var childNode = null;
            if (element.isSelf()) 
                childNode = node;
            else if (element.isParent())
                childNode = node.parent;
            else
                childNode = node._getChildDefAutoExpand(name, mustExist);
            node = childNode;
        }
        return node;
    }

    // See CXtkNodeDef::GetChildDefAutoExpand
    _getChildDefAutoExpand(name, mustExist) {
        var child = this.children[name];
        if (child)
            return child;
        
        // TODO: handle ref

        if (mustExist) {    
            // TODO: handle auto-expand schemas
            const path = this._getNodePath();
            const isAttribute = isAttributeName(name);
            const schemaDesc = this.schema.userDescription;
            if( path.isRootPath() ) {
                if (isAttribute) throw new DomException(`Unknown attribute '${name.substring(1)}' (see definition of schema '${schemaDesc}').`);
                else throw new DomException(`Unknown element '${name}' (see definition of schema '${schemaDesc}').`);
            }
            if (isAttribute) throw new DomException(`Unknown attribute '${name.substring(1)}' (see definition of element '${path.asString()}' in schema '${schemaDesc}').`);
            else throw new DomException(`Unknown element '${name}' (see definition of element '${path.asString()}' in schema '${schemaDesc}').`);
        }

        return null;
    }

    /**
     * Internal recursive function used to create a multi-line debug string representing the schema
     * 
     * @private
     * @param {string} indent indentation string, will be "" for the first, level, "   " for the next level, etc.
     * @returns {string} a multi-line string representing the schema definition in a human readable form for troubleshooting purposes
     */
    toString(indent) {
        indent = indent || "";
        var s = `${indent}${this.label} (${this.name})\n`;
        for (var name in this.children) {
            s = s + this.children[name].toString(`    ${indent}`);
        }
        return s;
    }

}

// ========================================================================================
// Enumerations
// ========================================================================================

/**
 * @typedef {('string'|'byte'|'short'|'long'|'boolean')} XtkEnumerationType
 * @memberOf Campaign 
 * 
 * @typedef {('sql'|'textFile'|'xmlFile'|'binaryFile')} XtkSchemaMappingType
 * @memberOf Campaign 
 */


/**
 * A system enumeration value
 * 
 * @private
 * @class
 * @constructor
 * @param {XML.XtkObject} The enumeration value definition
 * @param {Campaign.XtkEnumerationType} baseType the enumeration type (often "string" or "byte")
 * @memberof Campaign
 */
function XtkEnumerationValue(xml, baseType) {
    /**
     * The value (unique) name
     * @type {string}
     */
    this.name = EntityAccessor.getAttributeAsString(xml, "name");
    /**
     * A human friendly name describing the enumeration value
     * @type {string}
     */
    this.label = EntityAccessor.getAttributeAsString(xml, "label");
    /**
     * A human friendly long description of the value
     * @type {string}
     */
     this.description = EntityAccessor.getAttributeAsString(xml, "desc");
     /**
     * The value image (if any) or an empty string
     * @type {string}
     */
    this.image = EntityAccessor.getAttributeAsString(xml, "img");
    /**
     * The value "enabledIf" expression, or an empty string
     * @type {string}
     */
    this.enabledIf = EntityAccessor.getAttributeAsString(xml, "enabledIf");
    /**
     * The value "applicableIf" expression, or an empty string
     * @type {string}
     */
    this.applicableIf = EntityAccessor.getAttributeAsString(xml, "applicableIf");
    const stringValue = EntityAccessor.getAttributeAsString(xml, "value");
    /**
     * The enumeration value, casted according to the enumeration type
     * @type {*}
     */
    this.value = XtkCaster.as(stringValue, baseType);

    propagateImplicitValues(this, true);
}

/**
 * A system enumeration 
 * 
 * @private
 * @class
 * @constructor
 * @param {XML.XtkObject} xml the enumeration definition
 * @memberof Campaign
 */
class XtkEnumeration {
    constructor(schemaId, xml) {
        /**
         * The system enumeration name
         * @type {string}
         */
        this.name = EntityAccessor.getAttributeAsString(xml, "name");

        /**
         * A human friendly name for the system enumeration
         * @type {string}
         */
        this.label = EntityAccessor.getAttributeAsString(xml, "label");
        /**
         * A human friendly long description of the enumeration
         * @type {string}
         */
        this.description = EntityAccessor.getAttributeAsString(xml, "desc");
        /**
         * The type of the enumeration
         * @type {Campaign.XtkEnumerationType}
         */
        this.baseType = EntityAccessor.getAttributeAsString(xml, "basetype");
        /**
         * The default value of the enumeration
         * @type {Campaign.XtkEnumerationValue}
         */
        this.default = null;
        /**
         * Indicates if the enumeration has an image, i.e. if any of its values has an image
         * @type {boolean}
         */
        this.hasImage = false;
        /**
         * The enumerations values 
         * @type {Object<string, Campaign.XtkEnumerationValue>}
         */
         this.values = {};

        var defaultValue = EntityAccessor.getAttributeAsString(xml, "default");

        for (var child of EntityAccessor.getChildElements(xml, "value")) {
            const e = new XtkEnumerationValue(child, this.baseType);
            this.values[e.name] = e;
            if (e.image != "") this.hasImage = true;
            const stringValue = EntityAccessor.getAttributeAsString(child, "value");
            if (defaultValue == stringValue)
                this.default = e;
        }

        propagateImplicitValues(this, true);
    }
}

// ========================================================================================
// Schemas
// ========================================================================================

/**
 * A schema
 * 
 * @private
 * @class
 * @constructor
 * @augments Campaign.XtkSchemaNode
 * @param {XML.XtkObject} xml the schema definition
 * @memberof Campaign
 */
class XtkSchema extends XtkSchemaNode {

    constructor(application, xml) {
        super();
        this._application = application;

        /**
         * The namespace of the schema
         * @type {string}
         */
        this.namespace = EntityAccessor.getAttributeAsString(xml, "namespace");
        /**
         * The schema id, in the form "namespace:name"
         * @type {string}
         */
        this.name = EntityAccessor.getAttributeAsString(xml, "name");
        this.id = `${this.namespace}:${this.name}`;
        /**
         * Indicates whether the schema is a library schema or not
         * @type {boolean}
         */
        this.isLibrary = EntityAccessor.getAttributeAsBoolean(xml, "library");
        /**
         * A human name for the schema, in singular
         * @type {string}
         */
        this.labelSingular = EntityAccessor.getAttributeAsString(xml, "labelSingular");
        /**
         * The schema mappgin type, following the xtk:srcSchema:mappingType enumeration
         * @type {Campaign.XtkSchemaMappingType}
         */
        this.mappingType = EntityAccessor.getAttributeAsString(xml, "mappingType");
        /**
         * The MD5 code of the schema in the form of a hexadecimal string
         * @type {string}
         */
        this.md5 = EntityAccessor.getAttributeAsString(xml, "md5");
        /**
         * The schema definition
         * @private
         * @type {XML.XtkObject}
         */
        this.xml = xml;

        this.init(this, xml);

        /**
         * The schema root node, if it has one, i.e. the first child whose name matches the schema name
         * @type {Campaign.XtkSchemaNode}
         */
        this.root = this.children[this.name];
        
        /**
         * A user desciption of the node, in the form "label (name)"
         * @type {string}
         */
         this.userDescription = (this.label == this.name) ? this.name : `${this.label} (${this.name})`;

        /**
         * Enumerations in this schema, as a dictionary whose keys are enumeration names and values are the
         * corresponding enumeration definitions
         * @type {Object<string, XtkEnumeration>}
         */
         this.enumerations = {};

         for (var child of EntityAccessor.getChildElements(xml, "enumeration")) {
             const e = new XtkEnumeration(this.id, child);
             this.enumerations[e.name] = e;
         }
     }

    /**
     * Creates a multi-line debug string representing the schema
     * 
     * @returns {string} a multi-line string representing the schema definition in a human readable form for troubleshooting purposes
     */
    toString() {
        var s =  `${this.userDescription}\n`;
        for (var name in this.children) {
            s = s + this.children[name].toString("    - ");
        }
        return s;
    }
}



// ========================================================================================
// Current Login
// ========================================================================================

/**
 * Represents the currently logged operator. Do not create directly, this is available
 * as the sdk.application.operator variable
 * 
 * @private
 * @class
 * @constructor
 * @param {XML.XtkObject} userInfo the user info object as returned from the xtk:session#Logon call
 * @memberof Campaign
 */
class CurrentLogin {

    constructor(userInfo) {
        /**
         * The operator login name
         * @type {string}
         */
        this.login = EntityAccessor.getAttributeAsString(userInfo, "login");
        /**
         * The operator login id
         * @type {number}
         */
        this.id = EntityAccessor.getAttributeAsLong(userInfo, "loginId");
        /**
         * A human friendly string naming the operator (compute string)
         * @type {string}
         */
        this.computeString = EntityAccessor.getAttributeAsString(userInfo, "loginCS");
        /**
         * The operator timezone
         * @type {string}
         */
        this.timezone = EntityAccessor.getAttributeAsString(userInfo, "timezone");
        /**
         * The llist of operator rights
         * @type {string[]}
         */
        this.rights = [];
        this._rightsSet = {};
        for (var child of EntityAccessor.getChildElements(userInfo, "login-right")) {
            const right = EntityAccessor.getAttributeAsString(child, "right");
        this.rights.push(right);
        this._rightsSet[right] = true;
        }
    }

    /**
     * Tests if the operator has a given named right
     * 
     * @param {string} name the access right name
     * @returns {boolean} a boolean indicating whether the operator has the given right or not
     */
    hasRight(name) {
        return !!this._rightsSet[name];
    }

}

/**
 * Creates a current login object for testing purposes
 * 
 * @private
 * @param {XML.XtkObject} userInfo the user info object as returned from the xtk:session#Logon call 
 * @returns the CurrentLogin object corresponding to the passed object
 * @memberof Campaign
 */
function newCurrentLogin(userInfo) {
    return new CurrentLogin(userInfo);
}

// ========================================================================================
// Application
// ========================================================================================

/**
 * @class
 * @constructor
 * @param {Campaign.Client} client The Campaign Client from which this Application object is created
 * @memberof Campaign
 */
class Application {

    /**
     * The Application object provides access to certain properties of the Campaign server.
     * Do not create this object directly, it's automatically created by the Campaign.Client at Logon time
     * @private
     * @param {Campaign.Client} client the Campaign client representing the Campaign instance
     */
    constructor(client) {
        this.client = client;
        this._schemaCache = new SchemaCache(client);
        const info = this.client.getSessionInfo();
        // When using "SessionToken" authentication, there is no actual logon, and therefore
        // no "sessionInfo" object
        if (info) {
            const serverInfo = EntityAccessor.getElement(info, "serverInfo");
            /**
             * The server build number
             * @type {string}
             */
        this.buildNumber = EntityAccessor.getAttributeAsString(serverInfo, "buildNumber");
            /**
             * The Campaign instance name
             * @type {string}
             */
        this.instanceName = EntityAccessor.getAttributeAsString(serverInfo, "instanceName");
            const userInfo = EntityAccessor.getElement(info, "userInfo");
            /**
             * The logged operator
             * @type {Campaign.CurrentLogin}
             */
        this.operator = new CurrentLogin(userInfo);
            /**
             * The list of installed packages
             * @type {string[]}
             */
        this.packages = [];
            for (var p of EntityAccessor.getChildElements(userInfo, "installed-package")) {
            this.packages.push(`${EntityAccessor.getAttributeAsString(p, "namespace")}:${EntityAccessor.getAttributeAsString(p, "name")}`);
            }
        }
    }

    /**
     * Get a schema by id. This function returns an XtkSchema object or null if the schema is not found.
     * Using the `XtkSchema` API makes it easier to navigate schemas than using a plain XML or JSON object
     * 
     * @param {string} schemaId 
     * @returns {Campaign.XtkSchema} the schema, or null if the schema was not found
     */
     async getSchema(schemaId) {
        return this._schemaCache.getSchema(schemaId);
    }

    // Private function: get a schema without using the cache
    async _getSchema(schemaId) {
        const xml = await this.client.getSchema(schemaId, "xml");
        if (!xml)
            return null;
        return newSchema(xml, this);
    }

    /**
     * Tests if a package is installed or not
     * 
     * @param {string} name the package name
     * @returns {boolean} a boolean indicating whether the package is installed or not
     */
    hasPackage(name) {
        for (var p of this.packages) {
            if (p == name) return true;
        }
        return false;
    }
}



// Public exports
exports.Application = Application;

// For tests
exports.newSchema = newSchema;
exports.newCurrentLogin = newCurrentLogin;
exports.SchemaCache = SchemaCache;
})();
