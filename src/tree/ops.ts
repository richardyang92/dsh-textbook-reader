/**
 * Manual chapter-tree operations: rename, merge and level correction.
 *
 * Every operation preserves the two-level shape (chapters -> sections) and
 * refuses ambiguous transformations instead of silently producing overlapping
 * page ranges. Operations mark touched nodes as manual.
 */

import type { Tree, TreeNode } from '../types.js'
import { AppError } from '../errors.js'

export type TreeOperation =
  | { op: 'rename'; nodeId: string; title: string }
  | { op: 'merge'; nodeId: string }
  | { op: 'relevel'; nodeId: string; level: 1 | 2 }

export function applyTreeOp(tree: Tree, operation: TreeOperation): Tree {
  const next = structuredClone(tree)
  const node = findNode(next, operation.nodeId)
  if (operation.op === 'rename') return rename(next, node, operation.title)
  if (operation.op === 'merge') return merge(next, node)
  return relevel(next, node, operation.level)
}

function rename(tree: Tree, node: TreeNode, rawTitle: string): Tree {
  const title = String(rawTitle ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  if (!title) throw opError('标题不能为空。')
  node.title = title
  node.source = 'manual'
  tree.updatedAt = new Date().toISOString()
  return sortTree(tree)
}

function merge(tree: Tree, node: TreeNode): Tree {
  if (node.level === 2) {
    const parent = findNode(tree, node.parentId ?? '')
    const index = parent.children.indexOf(node.id)
    if (index <= 0) {
      // Merge the first section into its chapter: the chapter absorbs it.
      parent.pageEnd = Math.max(parent.pageEnd, node.pageEnd)
      parent.children.splice(index, 1)
      parent.source = 'manual'
      removeNode(tree, node.id)
      return sortTree(tree)
    }
    const previous = findNode(tree, parent.children[index - 1])
    previous.pageEnd = Math.max(previous.pageEnd, node.pageEnd)
    previous.source = 'manual'
    parent.children.splice(index, 1)
    removeNode(tree, node.id)
    return sortTree(tree)
  }

  const chapters = tree.nodes.filter((item) => item.level === 1).sort(byPage)
  const index = chapters.findIndex((item) => item.id === node.id)
  if (index <= 0) throw opError('第一章没有可合并的前一章。')
  const previous = chapters[index - 1]
  previous.pageEnd = Math.max(previous.pageEnd, node.pageEnd)
  previous.source = 'manual'
  for (const childId of node.children) {
    const child = findNode(tree, childId)
    child.parentId = previous.id
    previous.children.push(child.id)
  }
  removeNode(tree, node.id)
  return sortTree(tree)
}

function relevel(tree: Tree, node: TreeNode, level: 1 | 2): Tree {
  if (level === node.level) return sortTree(tree)

  if (node.level === 2 && level === 1) {
    const parent = findNode(tree, node.parentId ?? '')
    const index = parent.children.indexOf(node.id)
    if (index < 0) throw opError('节不属于当前章。')
    if (node.pageStart <= parent.pageStart) {
      throw opError('该节从章首页开始，提升会造成重叠；请先调整页码或合并。')
    }
    // Later sections follow the promoted section into its new chapter.
    const later = parent.children.splice(index + 1)
    parent.children.splice(index, 1)
    const oldParentEnd = parent.pageEnd
    parent.pageEnd = Math.max(parent.pageStart, node.pageStart - 1)
    parent.source = 'manual'
    node.level = 1
    node.parentId = ''
    delete node.parentId
    node.pageEnd = oldParentEnd
    node.children = []
    for (const childId of later) {
      const child = findNode(tree, childId)
      child.parentId = node.id
      node.children.push(child.id)
    }
    node.source = 'manual'
    return sortTree(tree)
  }

  // chapter -> section: attach to the previous chapter by page order.
  const chapters = tree.nodes.filter((item) => item.level === 1).sort(byPage)
  const index = chapters.findIndex((item) => item.id === node.id)
  if (index <= 0) throw opError('第一章不能降为节（没有前一章可挂靠）。')
  const previous = chapters[index - 1]
  const oldChildren = node.children
  node.level = 2
  node.parentId = previous.id
  node.children = []
  node.source = 'manual'
  previous.pageEnd = Math.max(previous.pageEnd, node.pageEnd)
  previous.children.push(node.id)
  for (const childId of oldChildren) {
    const child = findNode(tree, childId)
    child.parentId = previous.id
    previous.children.push(child.id)
  }
  previous.source = 'manual'
  return sortTree(tree)
}

function sortTree(tree: Tree): Tree {
  const chapters = tree.nodes.filter((node) => node.level === 1).sort(byPage)
  for (const [index, chapter] of chapters.entries()) {
    chapter.order = index
    chapter.children = chapter.children
      .map((id) => tree.nodes.find((node) => node.id === id && node.level === 2))
      .filter((node): node is TreeNode => Boolean(node))
      .sort(byPage)
      .map((node) => node.id)
    for (const [childIndex, childId] of chapter.children.entries()) {
      const child = tree.nodes.find((node) => node.id === childId)
      if (child) {
        child.parentId = chapter.id
        child.order = childIndex
      }
    }
  }
  const flat: TreeNode[] = []
  for (const chapter of chapters) {
    flat.push(chapter)
    for (const childId of chapter.children) {
      const child = tree.nodes.find((node) => node.id === childId)
      if (child) flat.push(child)
    }
  }
  tree.nodes = flat
  tree.updatedAt = new Date().toISOString()
  return tree
}

function findNode(tree: Tree, id: string): TreeNode {
  const node = tree.nodes.find((item) => item.id === id)
  if (!node) throw new AppError(404, 'node_not_found', '章节节点不存在。')
  return node
}

function removeNode(tree: Tree, id: string): void {
  tree.nodes = tree.nodes.filter((node) => node.id !== id)
}

function byPage(a: TreeNode, b: TreeNode): number {
  return a.pageStart - b.pageStart || a.order - b.order
}

function opError(message: string): AppError {
  return new AppError(422, 'tree_op_invalid', message)
}
