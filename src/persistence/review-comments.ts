/**
 * Review comments persistence for Clanky Tasks Management System.
 * Handles reading and writing review comments to the SQLite database.
 */

import { getDatabase } from "./database";
import { createLogger } from "@pablozaiden/webapp/server";
import { requirePersistenceUserId } from "./ownership";
import { scheduleMeshCheckpoint } from "./mesh-sync";

const log = createLogger("persistence:review-comments");

export interface MeshReviewComment {
  id: string;
  taskId: string;
  reviewCycle: number;
  commentText: string;
  createdAt: string;
  status: string;
  addressedAt?: string | null;
}

export function saveReviewCommentFromMesh(comment: MeshReviewComment): void {
  const userId = requirePersistenceUserId();
  getDatabase().run(`
    INSERT INTO review_comments (
      id, user_id, task_id, review_cycle, comment_text, created_at, status, addressed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      task_id = excluded.task_id,
      review_cycle = excluded.review_cycle,
      comment_text = excluded.comment_text,
      created_at = excluded.created_at,
      status = excluded.status,
      addressed_at = excluded.addressed_at
    WHERE review_comments.user_id = excluded.user_id
  `, [
    comment.id,
    userId,
    comment.taskId,
    comment.reviewCycle,
    comment.commentText,
    comment.createdAt,
    comment.status,
    comment.addressedAt ?? null,
  ]);
}

export function deleteReviewCommentFromMesh(commentId: string): boolean {
  return getDatabase().run(
    "DELETE FROM review_comments WHERE id = ? AND user_id = ?",
    [commentId, requirePersistenceUserId()],
  ).changes > 0;
}

/**
 * Insert a review comment into the database.
 */
export function insertReviewComment(comment: {
  id: string;
  taskId: string;
  reviewCycle: number;
  commentText: string;
  createdAt: string;
  status?: string;
}): void {
  log.debug("Inserting review comment", { id: comment.id, taskId: comment.taskId, reviewCycle: comment.reviewCycle });
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  db.run(
    `INSERT INTO review_comments (id, user_id, task_id, review_cycle, comment_text, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      comment.id,
      userId,
      comment.taskId,
      comment.reviewCycle,
      comment.commentText,
      comment.createdAt,
      comment.status ?? "pending",
    ]
  );
  scheduleMeshCheckpoint({
    userId,
    aggregateType: "review_comment",
    aggregateId: comment.id,
    payload: {
      id: comment.id,
      taskId: comment.taskId,
      reviewCycle: comment.reviewCycle,
      commentText: comment.commentText,
      createdAt: comment.createdAt,
      status: comment.status ?? "pending",
    },
  });
  log.debug("Review comment inserted", { id: comment.id });
}

/**
 * Get all review comments for a task.
 * Returns comments ordered by review_cycle DESC, created_at ASC.
 */
export function getReviewComments(taskId: string): Array<{
  id: string;
  task_id: string;
  review_cycle: number;
  comment_text: string;
  created_at: string;
  status: string;
  addressed_at: string | null;
}> {
  log.debug("Getting review comments", { taskId });
  const db = getDatabase();
  const comments = db.query(
    `SELECT * FROM review_comments 
     WHERE task_id = ? 
       AND user_id = ?
     ORDER BY review_cycle DESC, created_at ASC`
  ).all(taskId, requirePersistenceUserId()) as Array<{
    id: string;
    task_id: string;
    review_cycle: number;
    comment_text: string;
    created_at: string;
    status: string;
    addressed_at: string | null;
  }>;
  
  log.debug("Review comments retrieved", { taskId, count: comments.length });
  return comments;
}

/**
 * Update the status of all pending comments for a specific task and review cycle.
 * Used to mark comments as "addressed" when a task completes.
 */
export function markCommentsAsAddressed(taskId: string, reviewCycle: number, addressedAt: string): void {
  log.debug("Marking comments as addressed", { taskId, reviewCycle });
  const db = getDatabase();
  const userId = requirePersistenceUserId();
  const comments = db.query(`
    SELECT id, task_id, review_cycle, comment_text, created_at
    FROM review_comments
    WHERE task_id = ? AND user_id = ? AND review_cycle = ? AND status = 'pending'
  `).all(taskId, userId, reviewCycle) as Array<{
    id: string;
    task_id: string;
    review_cycle: number;
    comment_text: string;
    created_at: string;
  }>;
  db.run(
    `UPDATE review_comments 
     SET status = 'addressed', addressed_at = ?
     WHERE task_id = ? AND user_id = ? AND review_cycle = ? AND status = 'pending'`,
    [addressedAt, taskId, userId, reviewCycle]
  );
  for (const comment of comments) {
    scheduleMeshCheckpoint({
      userId,
      aggregateType: "review_comment",
      aggregateId: comment.id,
      payload: {
        id: comment.id,
        taskId: comment.task_id,
        reviewCycle: comment.review_cycle,
        commentText: comment.comment_text,
        createdAt: comment.created_at,
        status: "addressed",
        addressedAt,
      },
    });
  }
  log.debug("Comments marked as addressed", { taskId, reviewCycle, addressedAt });
}
