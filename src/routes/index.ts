import { Router, type IRouter } from "express";
import healthRouter from "./health";
import modelsRouter from "./models";
import datasetsRouter from "./datasets";
import usersRouter from "./users";
import organizationsRouter from "./organizations";
import statsRouter from "./stats";
import searchRouter from "./search";
import openaiRouter from "./openai";
import collabRouter from "./collab";
import agentsRouter from "./agents";

const router: IRouter = Router();

router.use(healthRouter);
router.use(modelsRouter);
router.use(datasetsRouter);
router.use(usersRouter);
router.use(organizationsRouter);
router.use(statsRouter);
router.use(searchRouter);
router.use(openaiRouter);
router.use(collabRouter);
router.use(agentsRouter);

export default router;
