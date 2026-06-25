import { setCurrentUserForTesting } from "../src/core/user-context";
import { testOwnerUser } from "./setup";

setCurrentUserForTesting(testOwnerUser);
