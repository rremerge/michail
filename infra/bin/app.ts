#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CalendarStack } from "../lib/calendar-stack";

const app = new cdk.App();

new CalendarStack(app, "CalendarStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1"
  }
});
