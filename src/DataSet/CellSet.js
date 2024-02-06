class CellSet extends DataSetComponent {
    
  // Cells is an array indexed by columntupleIndex * rowTupleIndex
  // Cells array elements are objects having a values property.
  // The values property is an array of values corresponding (by position) to the items of the cells axis
  #cells = [];
  #cellValueFields = {};
  
  #tupleSets = [];
  
  static #datasetRelationName = '__data';   
  static #tupleDataRelationName = '__huey_tuples';
  static #cellIndexColumnName = '__huey_cellIndex';
  static #countStarExpressionAlias = '__huey_count_star';
   
  constructor(queryModel, tupleSets){
    super(queryModel);
    this.#tupleSets = tupleSets;
  }
  
  clear(){
    this.#cells = [];
    this.#cellValueFields = {};
  }  

  getCellValueFields(){
    return this.#cellValueFields;
  }

  // variable argument list,
  // each argument should be a tuple index
  // tuple indexes should by in order of tupleSets
  getCellIndex(){
    var cellIndex = 0;
    var tupleSets = this.#tupleSets;
    var numTupleSets = tupleSets.length || 0;
    
    // for each tupleset ...
    for (var i = 0; i < numTupleSets; i++){
      var tupleIndex = arguments[i];
      var factor = tupleIndex;
      // ...get the factor for all downstream tuplesets.
      for (var j = i + 1; j < numTupleSets; j++){
        var tupleSet = tupleSets[j];
        var numTuples = tupleSet.getTupleCountSync();
        if (!numTuples) {
          continue;
        }
        factor *= numTuples;
      }
      cellIndex += factor;
    }
    return cellIndex;
  }
  
  // convenience method.
  // calls getCellIndex and returns the corresponding (cached) cell
  // returns undefined if the cell does not exist.
  #getCell(){
    var cellIndex = this.getCellIndex.apply(this, arguments);
    var cells = this.#cells;
    var cell = cells[cellIndex];
    return cell;
  }

  getTupleRanges(ranges, previousTupleIndices, allRanges){
    var numRanges = ranges.length;

    if (!previousTupleIndices){
      allRanges = [];
      previousTupleIndices = [];
    }
    
    if (numRanges === 0) {
      allRanges.push(previousTupleIndices);
      return allRanges;
    }
    
    var tupleSets = this.#tupleSets;

    var numTupleSets = tupleSets.length;

    var tupleSetIndex = numTupleSets - numRanges;
    var tupleSet = tupleSets[tupleSetIndex];

    var range = ranges.shift();
    var fromTuple = range[0];
    var toTuple = range[1];
    
    if (fromTuple === 0 && toTuple === 0) {
      toTuple = 1;
    }
    
    for (var i = fromTuple; i < toTuple; i++){
      var rangesCopy = [].concat(ranges);

      var previousTupleIndicesCopy = [].concat(previousTupleIndices);
      previousTupleIndicesCopy.push(i);
      
      this.getTupleRanges(rangesCopy, previousTupleIndicesCopy, allRanges);
    }
    return allRanges;
  }
  
  #getValuesClauseForCellsQuery(tupleQueryAxisItems, tupleValueToColumnMapping, tuplesToQuery){
    var allDataPaceHoldersSql = tuplesToQuery.map(function(tuple, tupleIndex){
      var tupleQueryAxisItemIndex = 0;
      var valuesClauseRow = Object.keys(tuple).map(function(columnName){
        var value = tuple[columnName];
        if (columnName === CellSet.#cellIndexColumnName) {
          // we serialize the cellindex explicitly as a matter of principle: it is a value we assign,
          // whereas the tuple values are truly input values.
          // and it helps to clearly mark each tuple 
          return String(value);
        }

        var mappingInfo = tupleValueToColumnMapping[columnName];
        var tupleValueField = mappingInfo.tupleValueField;

        var tupleQueryAxisItem = tupleQueryAxisItems[tupleQueryAxisItemIndex++];
        var literalWriter = tupleQueryAxisItem.literalWriter;
        var literal = literalWriter(value, tupleValueField);
        return literal;
      });
      return `(${valuesClauseRow})`
    }).join('\n,');

    var columns = [CellSet.#cellIndexColumnName].concat(Object.keys(tupleValueToColumnMapping));
    var relationDefinition = `${getQuotedIdentifier(CellSet.#tupleDataRelationName)}(${columns.map(getQuotedIdentifier).join(', ')})`;

    var valuesClause = `(VALUES\n ${allDataPaceHoldersSql}\n) AS ${relationDefinition}`;
    return valuesClause;
  }
  
  #getSqlQueryForCells(
    tupleQueryAxisItems, 
    tuplesToQuery, 
    tupleValueToColumnMapping, 
    aggregateExpressionsToFetch, 
    subQueryColumnNames,
    superAggregateTuplesToQuery
  ){
    var queryModel = this.getQueryModel();
    var datasource = queryModel.getDatasource();
    var aliasedDatasetName = datasource.getRelationExpression(CellSet.#datasetRelationName); 

    aggregateExpressionsToFetch = Object.keys(aggregateExpressionsToFetch).map(function(expression){
      return `${aggregateExpressionsToFetch[expression]} AS ${getQuotedIdentifier(expression)}`;
    });

    // build the SELECT list
    var quotedCellIndexColumnName = getQuotedIdentifier(CellSet.#cellIndexColumnName);
    var qualifiedCellIndexColumnName = getQualifiedIdentifier(CellSet.#tupleDataRelationName, CellSet.#cellIndexColumnName);
        
    var tupleIndexSelectExpression = `CAST(${tuplesToQuery.length === 0 ? '0' : qualifiedCellIndexColumnName} AS INTEGER) AS ${quotedCellIndexColumnName}`;
    
    var groupByClause;
    var selectListExpressions = [tupleIndexSelectExpression].concat(aggregateExpressionsToFetch);
    if (superAggregateTuplesToQuery.length) {
      // if we have super aggregate tuples we need to add the axis columns to the select list
      var i = 0, groupByList = [], groupingSets = [];
      for (var columnName in tupleValueToColumnMapping){
        var columnExpression = getQualifiedIdentifier(CellSet.#tupleDataRelationName, columnName);
        selectListExpressions.push(columnExpression);
        groupByList.push(columnExpression);
        var tupleQueryAxisItem = tupleQueryAxisItems[i++];
        if (tupleQueryAxisItem.includeTotals){
          groupingSets.push([].concat(groupByList));
        }
      }
      groupingSets.push([qualifiedCellIndexColumnName].concat(groupByList));
      groupByClause = 'GROUP BY GROUPING SETS (\n' + groupingSets.map(function(groupingSet){
        return `(${groupingSet.join('\n,')})`;
      }).join('\n, ') + '\n)';
    }
    else {
      groupByClause = `GROUP BY ${qualifiedCellIndexColumnName}`;      
    }
    
    var selectClauseSql = `SELECT ${selectListExpressions.join('\n, ')}`;
    var filterCondition = queryModel.getFilterConditionSql(true, CellSet.#datasetRelationName);
  
    var sql;
    if (tuplesToQuery.length === 0) {
      sql = [
        selectClauseSql,
        `FROM ${aliasedDatasetName}`
      ];
      
      if (filterCondition) {
        sql.push(`WHERE ${filterCondition}`);
      }
      sql = sql.join('\n');
      return sql;
    }

    // build the FROM clause
    var valuesClause = this.#getValuesClauseForCellsQuery(tupleQueryAxisItems, tupleValueToColumnMapping, tuplesToQuery);
    var fromClause = `FROM ${valuesClause}`;
    
    // build the JOIN clause
    var joinClause = 'LEFT JOIN ';
    if (subQueryColumnNames) {
      var subQueryColumnExpressions = Object.keys(subQueryColumnNames).map(getQuotedIdentifier);
      subQueryColumnExpressions.push(`1 AS ${getQuotedIdentifier(CellSet.#countStarExpressionAlias)}`);
      var subquery = [
        `  SELECT ${subQueryColumnExpressions.join('\n,')}`,
        `  FROM ${aliasedDatasetName}`
      ];
      
      if (filterCondition) {
        subquery.push(`  WHERE ${filterCondition}`);
      }
      joinClause += `(\n${subquery.join('\n')}\n) AS ${getQuotedIdentifier(CellSet.#datasetRelationName)}`;
    }
    else {
      joinClause += aliasedDatasetName;
    }
    var joinConditionsSql = Object.keys(tupleValueToColumnMapping).map(function(columnName){
      var mappingInfo = tupleValueToColumnMapping[columnName];
      var sqlExpression = mappingInfo.sqlExpression;
      var dataColumnName = getQualifiedIdentifier(CellSet.#tupleDataRelationName, columnName);
      var comparisonExpression = `${dataColumnName} = ${sqlExpression}`;
      if (mappingInfo.nullValueCount > 0) {
        var nullComparisonExpression = `${dataColumnName} IS NULL AND ${sqlExpression} IS NULL`;
        comparisonExpression = `( ${comparisonExpression} OR ${nullComparisonExpression} )`
      }
      return comparisonExpression;
    });
    var joinConditionSql = joinConditionsSql.join('\nAND ');
    var onClause = `ON ${joinConditionSql}`;

    if (filterCondition && !subQueryColumnNames) {
      onClause = [
        onClause,
        `AND ${filterCondition}`
      ].join('\n');
    }
            
    // build the statement
    sql = [
      selectClauseSql,
      fromClause,
      joinClause,
      onClause,
      groupByClause
    ].join('\n');
    return sql;
  }
  
  async #executeCellsQuery(
    tupleQueryAxisItems, 
    tuplesToQuery, 
    tupleValueToColumnMapping, 
    aggregateExpressionsToFetch, 
    subQueryColumnNames,
    superAggregateTuplesToQuery
  ) {
    var sql = this.#getSqlQueryForCells(
      tupleQueryAxisItems, 
      tuplesToQuery, 
      tupleValueToColumnMapping, 
      aggregateExpressionsToFetch, 
      subQueryColumnNames,
      superAggregateTuplesToQuery
    );
    var connection = this.getManagedConnection();
    var resultSet = await connection.query(sql);
    return resultSet;
  }
  
  #extractCellsFromResultset(resultSet){
    var cells = {};
    var fields = resultSet.schema.fields;
    for (var i = 0; i < resultSet.numRows; i++){
      var row = resultSet.get(i);
      var cellIndex, cell;
      for (var j = 0; j < fields.length; j++){
        var field = fields[j];
        var fieldName = field.name;
        if (this.#cellValueFields[fieldName] === undefined) {
          this.#cellValueFields[fieldName] = field;
        }
        var value = row[fieldName];
        
        if (j === 0) {
          cellIndex = value;
          // check if we already cached the cell, 
          // because if it already exists then we will update it with the newly fetched metrics
          cell = this.#cells[cellIndex];
          if (cell === undefined){
            // cell didn't exist! So lets add it.
            this.#cells[cellIndex] = cell = {values: {}};
          }
        }
        else {
          cell.values[fieldName] = value;
        }
      }
      cells[cellIndex] = cell;
    }
    return cells;
  }

  // ranges is aa list of tuple index pairs
  async getCells(ranges){
    var queryModel = this.getQueryModel();
    var cellsAxis = queryModel.getCellsAxis();
    var cellsAxisItems = cellsAxis.getItems();
    
    if (cellsAxisItems.length === 0){
      return undefined;
    }
    
    var tupleIndices = this.getTupleRanges(ranges);
    var tupleSets = this.#tupleSets;
    var cells = this.#cells;
    
    // this is where we collect the cells, keyed by cellIndex, 
    var availableCells = {};

    // this is where we keep  the collection of values of the tuples 
    // for which we currently don't have all required cell values
    // along with the tuple values, we store the cellIndex toolbar
    // we will then use this to create an arrow table 
    var tuplesToQuery = [];
    // if there are totals, then we need to apply grouping sets so the main query produces super-aggregate rows
    // and then we have to look up their tupleindices 
    var superAggregateTuplesToQuery = [];
    // this is where we keep the mapping between column names of the tuple data set 
    // and the corresponding sql expressions in the main dataset.
    // we need that to correlate the filter the dataset based on the tuple data 
    var tupleValueToColumnMapping = {};
    // there query axis items contain most information we need to write a query,
    // we collect them in this array.
    // (note that this is populated with query axis items from all axes currently in the rows and columns axes of the query model
    var tupleQueryAxisItems = [];
    // this is where we store the sql expressions that calculate the cell values.
    // If there are cells missing, this will contain expressions for each cells axis items
    // but if all cells were already present and just missed a particular metric, only those metric need to be calculated.
    var aggregateExpressionsToFetch = {};
    
    // if we have a count(*) aggregate, and we also have tuples, then we do a LEFT JOIN of our tuple data against the dataset,
    // where we join the actual tuple values against the corresponding expressions of the dataset.
    // in that case, COUNT(*) is not an accurate count because it will simply count all rows resulting from the left join, 
    // whereas we intended to count only the matching rows in the dataset.
    // (remember that the tuple data represent combinations from both query axes, and such a combination might not exist in the dataset )
    // To obtain an accurate count, we have to apply the count to an actual column. 
    // For this we take any arbitrary column corresponding to the tuple values.
    // interstingly it doesn't really matter if the column itself is nullable, because if it would be null, 
    // it would alraedy be filtered out by the ON condition.
    var indexOfCountStarAggregate = undefined;
    var countStarCellsAxisItem = undefined;
    var tupleColumnNames = [];
       
    // combine values from tuples of different axes into one 'supertuple'       
    _combinedTuples: for (var i = 0; i < tupleIndices.length; i++){
      var tupleIndicesItem = tupleIndices[i];
      var cellIndex = this.getCellIndex.apply(this, tupleIndicesItem);
      var cell = cells[cellIndex];
            
      // make a reference to the cell which we will use to check if we need to add more aggregate sql expressions
      var cellCopy = cell;
      for (var j = 0; j < cellsAxisItems.length; j++){
        var cellsAxisItem = cellsAxisItems[j];
        if (indexOfCountStarAggregate === undefined && cellsAxisItem.aggregator === 'count' && cellsAxisItem.columnName === '*'){
          countStarCellsAxisItem = cellsAxisItem;
        }
        
        var sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(cellsAxisItem, CellSet.#datasetRelationName);
        
        if (!cellCopy || (cellCopy && cellCopy.values[sqlExpression] === undefined) ){
          // we have a cell, but the cell doesn't have a value for this axis item.
          // this means the cell is not complete so we must fetch it. 
          cell = undefined;
          
          // if we aren't already querying this aggregate, then we add it too.
          if (aggregateExpressionsToFetch[sqlExpression] === undefined) {
            aggregateExpressionsToFetch[sqlExpression] = sqlExpression;
          }
        }          
      }

      if (cell) {
        // If we arrive here, and we still have the cell, 
        // it means the cell was not only already cached, but also contains values for all currently reqyested cells axis items.
        // We can serve the cell from the cache and we don't need to include it in our SQL.
        availableCells[cellIndex] = cell;
        continue;
      }
            
      // If we arrive here, the cell is either not cached, or incomplete,
      // i.e. it lacks one or more values corresponding to the requested cells axis items. 
      // If even one cells axis item value is missing, we have to include the cell in our query.
      var row = {};
      row[CellSet.#cellIndexColumnName] = cellIndex;
      
      // for each query axis...
      var isTotalsTuple = false;
      _tuplesetIndices: for (var j = 0; j < tupleIndicesItem.length; j++){
                
        // ...get the tuple,...
        var tupleIndex = tupleIndicesItem[j];
        var tupleSet = tupleSets[j];
                
        var tuple = tupleSet.getTupleSync(tupleIndex);
        if (!tuple) {
          //console.error(`Couldn't find tuple ${tupleIndex} in tupleset for query axis ${tupleSet.getQueryAxisId()}`);
          continue;
        }
        
        if (tuple[TupleSet.groupingIdAlias]){
          isTotalsTuple = true;
        }
        
        var tupleValues = tuple.values;
        
        var queryAxisId = tupleSet.getQueryAxisId();
        var queryAxis = queryModel.getQueryAxis(queryAxisId);
        var queryAxisItems = queryAxis.getItems();

        for (var k = 0; k < queryAxisItems.length; k++){
          // ...and extract and store the values in our row.
          var queryAxisItem = queryAxisItems[k];
          
          // maintain the list of columns in case we need a count(*) aggregate
          if (tupleColumnNames.indexOf(queryAxisItem.columnName === -1)){
            tupleColumnNames.push( queryAxisItem.columnName );
          }
          
          var tupleValue = tupleValues[k];
          var columnName = `${queryAxisId}_value${k}`;
          row[columnName] = tupleValue;
          
          if (tuplesToQuery.length === 0){
            tupleQueryAxisItems.push(queryAxisItem);
            // collect metadata, only once for the entire set (done along with the first tuple)
            var tupleSetValueFields = tupleSet.getTupleValueFields();
            // store the mapping between our literal row column and the original sql expression
            var sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(queryAxisItem, CellSet.#datasetRelationName);
            tupleValueToColumnMapping[columnName] = {
              sqlExpression: sqlExpression,
              tupleValueField: tupleSetValueFields[k],
              nullValueCount: 0
            };
          }        
        }
      }

      // check if we gathered any tuple data (and the tuple is not a totals tuple)
      if (Object.keys(row).length > 1) {
        if (isTotalsTuple) {
          superAggregateTuplesToQuery.push(row);
        }
        else {
          for (columnName in row){
            if (row[columnName] === null) {
              // keep track of the  null values - 
              // if there are null values in the tuples, 
              // we need to take that into account in the join clause when fetching the cell values
              tupleValueToColumnMapping[columnName].nullValueCount += 1;
            }
          }
          // it's possible to have no tuples in case there are only cells axis items and no items on rows/columns.
          tuplesToQuery.push(row);
        }
      }
    }
    
    if (Object.keys(aggregateExpressionsToFetch).length){
      var subqueryColumnNames;
      // if we have a count star expression, we need to apply it to a column that does not have NULLs.
      // we do not have proper nullability metadata (duckdb will report nulllable columns in csv files even though there are 0 NULL occurrences in the column)
      // But we do know if the columns from our tuple values happen to have nulls or not because we stored that in nullValueCount in the mapping info
      // So we can use that to select a column that is not-nullable at least in the scope of this query.
      if (countStarCellsAxisItem !== undefined && tupleColumnNames.length) {
        var countStarExpressionAlias = QueryAxisItem.getSqlForQueryAxisItem(countStarCellsAxisItem, CellSet.#datasetRelationName);
        
        var countStarCellsAxisItemCopy = Object.assign({}, countStarCellsAxisItem);

        // we cannot find a non-nullable 'natural' column, we can create one by adding a constant value and wrapping it in a subquery.
        subqueryColumnNames = {};
        for (var i = 0; i < tupleColumnNames.length; i++) {
          var tupleColumnName = tupleColumnNames[i];
          if (subqueryColumnNames[tupleColumnName] === undefined) {
            subqueryColumnNames[tupleColumnName] = tupleColumnName;
          }
        }
        for (var i = 0; i < cellsAxisItems.length; i++){
          var cellsAxisItem = cellsAxisItems[i];
          var cellsAxisItemColumnName = cellsAxisItem.columnName;
          if (cellsAxisItemColumnName === '*' && cellsAxisItem.aggregator === 'count') {
            continue;
          }
          if (subqueryColumnNames[cellsAxisItemColumnName] === undefined) {
            subqueryColumnNames[cellsAxisItemColumnName] = cellsAxisItemColumnName;
          }
        }
        countStarCellsAxisItemCopy.columnName = CellSet.#countStarExpressionAlias;

        var sqlExpression = QueryAxisItem.getSqlForQueryAxisItem(countStarCellsAxisItemCopy, CellSet.#datasetRelationName);
        
        aggregateExpressionsToFetch[countStarExpressionAlias] = sqlExpression;
      }
      var resultset = await this.#executeCellsQuery(
        tupleQueryAxisItems, 
        tuplesToQuery, 
        tupleValueToColumnMapping, 
        aggregateExpressionsToFetch, 
        subqueryColumnNames, 
        superAggregateTuplesToQuery
      );
      var newCells = this.#extractCellsFromResultset(resultset);
      Object.assign(availableCells, newCells);
    }
    
    return availableCells;
  }    
  
}
