/** Persisted chapter trees and their structural validation. */

import { join } from 'node:path'
import type { Tree, TreeNode } from '../types.js'
import { AppError } from '../errors.js'
import type { DataPaths } from '../config.js'
import { assertBookId } from './books.js'
import { readJsonFile, writeJsonAtomic } from './atomic.js'
import { KeyedLock } from './lock.js'

const TREE_FILE = 'tree.json'

export class TreeStore {
  readonly paths: DataPaths
  private readonly lock = new KeyedLock()

  constructor(paths: DataPaths) {
    this.paths = paths
  }

  treeFile(bookId: string): string {
    assertBookId(bookId)
    return join(this.paths.books, bookId, TREE_FILE)
  }

  async read(bookId: string): Promise<Tree | undefined> {
    const tree = await readJsonFile<Tree>(this.treeFile(bookId))
    if (!tree) return undefined
    validateTree(tree)
    return tree
  }

  async save(bookId: string, tree: Tree): Promise<Tree> {
    return this.lock.run(bookId, async () => {
      validateTree(tree)
      const next: Tree = { ...tree, bookId, updatedAt: new Date().toISOString() }
      await writeJsonAtomic(this.treeFile(bookId), next, 0o600)
      return next
    })
  }
}

export function validateTree(tree: Tree): void {
  if (!tree || tree.version !== 1) throw stateError('树版本不支持。')
  if (!Array.isArray(tree.nodes)) throw stateError('树节点缺失。')
  const ids = new Set<string>()
  for (const node of tree.nodes) {
    if (typeof node.id !== 'string' || node.id.length < 1 || node.id.length > 128) {
      throw stateError('树节点 ID 不合法。')
    }
    if (ids.has(node.id)) throw stateError('树节点 ID 重复。')
    ids.add(node.id)
    if (node.level !== 1 && node.level !== 2) throw stateError('树层级不合法。')
    if (typeof node.title !== 'string' || node.title.trim() === '') throw stateError('树节点标题为空。')
    if (!Number.isInteger(node.pageStart) || node.pageStart < 1) throw stateError('树节点起始页不合法。')
    if (!Number.isInteger(node.pageEnd) || node.pageEnd < node.pageStart) {
      throw stateError('树节点结束页不合法。')
    }
    if (!Array.isArray(node.children)) throw stateError('树节点 children 不合法。')
    if (node.level === 2 && typeof node.parentId !== 'string') {
      throw stateError('节节点缺少父节点。')
    }
    if (node.level === 1 && node.parentId !== undefined) {
      throw stateError('章节点不应有父节点。')
    }
  }
  for (const node of tree.nodes) {
    for (const childId of node.children) {
      if (!ids.has(childId)) throw stateError('树子节点不存在。')
      const child = tree.nodes.find((item) => item.id === childId)
      if (!child || child.level !== 2 || child.parentId !== node.id) {
        throw stateError('树子节点关系不一致。')
      }
    }
    if (node.level === 2 && !ids.has(node.parentId ?? '')) {
      throw stateError('树父节点不存在。')
    }
    if (node.level === 1) {
      for (const childId of node.children) {
        const child = tree.nodes.find((item) => item.id === childId)
        if (child && child.pageStart < node.pageStart) throw stateError('子节点页码早于父节点。')
      }
    }
  }
}

function stateError(message: string): AppError {
  return new AppError(500, 'tree_corrupt', message)
}

/** Convenience for tests: flatten a tree in display order. */
export function treeNodeMap(tree: Tree): Map<string, TreeNode> {
  return new Map(tree.nodes.map((node) => [node.id, node]))
}
