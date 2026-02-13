import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2i from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";

export class CalendarStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const appointmentsTable = new dynamodb.Table(this, "AppointmentsTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "appointmentAt", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const calendarApiFn = new lambda.Function(this, "CalendarApiFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 200, body: JSON.stringify({ message: 'Replace with backend handlers' }) });"
      ),
      environment: {
        APPOINTMENTS_TABLE_NAME: appointmentsTable.tableName
      }
    });

    const emailProcessorFn = new lambda.Function(this, "EmailProcessorFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(
        "exports.handler = async () => { console.log('Replace with backend email handler'); };"
      ),
      environment: {
        APPOINTMENTS_TABLE_NAME: appointmentsTable.tableName
      }
    });

    appointmentsTable.grantReadWriteData(calendarApiFn);
    appointmentsTable.grantReadWriteData(emailProcessorFn);

    const httpApi = new apigwv2.HttpApi(this, "CalendarHttpApi", {
      apiName: "calendar-api"
    });

    httpApi.addRoutes({
      path: "/calendar",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2i.HttpLambdaIntegration("CalendarApiIntegration", calendarApiFn)
    });

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true
    });

    new cdk.CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "FrontendBucketName", { value: frontendBucket.bucketName });
  }
}
