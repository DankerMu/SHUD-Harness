import ts from "typescript";

type Scope = {
  readonly parent: Scope | undefined;
  readonly declarations: Map<string, ts.Declaration>;
  readonly functionScope: boolean;
};
type BindingLeaf = Readonly<{ name: string; declaration: ts.Declaration }>;

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node);
}

function variableDeclarationFor(declaration: ts.Declaration): ts.VariableDeclaration | undefined {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current;
    if (ts.isSourceFile(current) || isFunctionLike(current)) return undefined;
  }
  return undefined;
}

function parameterFor(declaration: ts.Declaration): ts.ParameterDeclaration | undefined {
  for (let current: ts.Node | undefined = declaration; current; current = current.parent) {
    if (ts.isParameter(current)) return current;
    if (ts.isSourceFile(current) || isFunctionLike(current)) return undefined;
  }
  return undefined;
}

function assignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.EqualsToken && kind <= ts.SyntaxKind.QuestionQuestionEqualsToken;
}

function writeTarget(identifier: ts.Identifier): boolean {
  let current: ts.Node = identifier;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return false;
    if (ts.isPropertyAssignment(parent)) {
      if (parent.name === current && !ts.isShorthandPropertyAssignment(parent)) return false;
      current = parent;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(parent) || ts.isSpreadAssignment(parent) ||
        ts.isSpreadElement(parent) || ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) {
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent) && parent.left === current && assignmentOperator(parent.operatorToken.kind)) {
      return true;
    }
    if (ts.isPrefixUnaryExpression(parent) && parent.operand === current &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
      return true;
    }
    if (ts.isPostfixUnaryExpression(parent) && parent.operand === current) return true;
    if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === current) {
      return true;
    }
    return false;
  }
}

function bindingLeafDeclarations(declaration: ts.Declaration): readonly BindingLeaf[] {
  const named = declaration as ts.Declaration & { name?: ts.BindingName };
  if (!named.name) return [];
  const leaves: BindingLeaf[] = [];
  const visit = (name: ts.BindingName, owner: ts.Declaration): void => {
    if (ts.isIdentifier(name)) {
      leaves.push({ name: name.text, declaration: owner });
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) visit(element.name, element as unknown as ts.Declaration);
    }
  };
  visit(named.name, declaration);
  return leaves;
}

export function declarationName(declaration: ts.Node | undefined): string | undefined {
  const named = declaration as (ts.Node & { name?: ts.BindingName }) | undefined;
  return named?.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

export function isDeclarationName(identifier: ts.Identifier, declaration: ts.Declaration): boolean {
  const named = declaration as ts.Declaration & { name?: ts.BindingName };
  return named.name === identifier;
}

export class LexicalBindings {
  readonly #scopeByNode = new WeakMap<ts.Node, Scope>();
  readonly #allDeclarations: ts.Declaration[] = [];
  readonly #seenDeclarations = new Set<ts.Declaration>();

  constructor(source: ts.SourceFile) {
    const scope: Scope = { parent: undefined, declarations: new Map(), functionScope: true };
    this.#scopeByNode.set(source, scope);
    this.#predeclareStatements(source.statements, scope);
    for (const statement of source.statements) this.#visit(statement, scope);
  }

  declarations(): readonly ts.Declaration[] {
    return this.#allDeclarations;
  }

  resolve(identifier: ts.Identifier): ts.Declaration | undefined {
    let scope = this.#scopeByNode.get(identifier);
    for (; scope; scope = scope.parent) {
      const declaration = scope.declarations.get(identifier.text);
      if (declaration) return declaration;
    }
    return undefined;
  }

  #declare(scope: Scope, declaration: ts.Declaration): void {
    for (const { name, declaration: binding } of bindingLeafDeclarations(declaration)) {
      scope.declarations.set(name, binding);
      if (!this.#seenDeclarations.has(binding)) {
        this.#seenDeclarations.add(binding);
        this.#allDeclarations.push(binding);
      }
    }
  }

  #functionScope(scope: Scope): Scope {
    let current = scope;
    while (!current.functionScope) current = current.parent!;
    return current;
  }

  #declareVariableList(list: ts.VariableDeclarationList, scope: Scope): void {
    const target = (list.flags & ts.NodeFlags.BlockScoped) === 0 ? this.#functionScope(scope) : scope;
    for (const declaration of list.declarations) this.#declare(target, declaration);
  }

  #predeclareStatements(statements: readonly ts.Statement[], scope: Scope): void {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement)) {
        this.#declare(scope, statement);
      } else if (ts.isVariableStatement(statement)) {
        this.#declareVariableList(statement.declarationList, scope);
      } else if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        this.#declare(scope, statement);
      }
    }
  }

  #visit(node: ts.Node, scope: Scope): void {
    this.#scopeByNode.set(node, scope);
    if (isFunctionLike(node)) {
      const functionScope: Scope = { parent: scope, declarations: new Map(), functionScope: true };
      this.#scopeByNode.set(node, functionScope);
      if (ts.isFunctionExpression(node) && node.name) this.#declare(functionScope, node);
      for (const parameter of node.parameters) this.#declare(functionScope, parameter);
      for (const parameter of node.parameters) this.#visit(parameter, functionScope);
      if (node.body && ts.isBlock(node.body)) {
        this.#scopeByNode.set(node.body, functionScope);
        this.#predeclareStatements(node.body.statements, functionScope);
        for (const statement of node.body.statements) this.#visit(statement, functionScope);
      } else if (node.body) {
        this.#visit(node.body, functionScope);
      }
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: Scope = { parent: scope, declarations: new Map(), functionScope: false };
      this.#scopeByNode.set(node, blockScope);
      this.#predeclareStatements(node.statements, blockScope);
      for (const statement of node.statements) this.#visit(statement, blockScope);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope: Scope = { parent: scope, declarations: new Map(), functionScope: false };
      this.#scopeByNode.set(node, loopScope);
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) this.#declareVariableList(initializer, loopScope);
      ts.forEachChild(node, (child) => this.#visit(child, loopScope));
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = { parent: scope, declarations: new Map(), functionScope: false };
      this.#scopeByNode.set(node, catchScope);
      if (node.variableDeclaration) {
        this.#declare(catchScope, node.variableDeclaration);
        this.#visit(node.variableDeclaration, catchScope);
      }
      this.#visit(node.block, catchScope);
      return;
    }
    if (ts.isVariableDeclarationList(node)) this.#declareVariableList(node, scope);
    ts.forEachChild(node, (child) => this.#visit(child, scope));
  }
}

export function bindingHasWrite(declaration: ts.Declaration, bindings: LexicalBindings): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.resolve(node) === declaration &&
        !isDeclarationName(node, declaration) && writeTarget(node)) {
      written = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return written;
}

export function stableBinding(declaration: ts.Declaration, bindings: LexicalBindings): boolean {
  const variable = variableDeclarationFor(declaration);
  return ((variable !== undefined && (variable.parent.flags & ts.NodeFlags.Const) !== 0) ||
    parameterFor(declaration) !== undefined) && !bindingHasWrite(declaration, bindings);
}
