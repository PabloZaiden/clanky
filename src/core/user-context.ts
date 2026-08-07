/**
 * Compatibility exports for callers that still use the historical Core path.
 */

export {
  getCurrentUser,
  getCurrentUserId,
  requireCurrentUser,
  requireCurrentUserId,
  runWithCurrentUser,
  setCurrentUserForTesting,
} from "../context/user-context";
