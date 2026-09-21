import { setCurrentUserForTesting } from "../src/context/user-context";
import { testOwnerUser } from "./setup";

setCurrentUserForTesting(testOwnerUser);
