#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HapiStack } from './hapi';

const app = new cdk.App();

// HAPI FHIR load testing stack with 3 VMs: HAPI, PostgreSQL, and Locust
new HapiStack(app, 'HapiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'HAPI FHIR, PostgreSQL, and Locust load testing infrastructure (3 VMs)',
});
