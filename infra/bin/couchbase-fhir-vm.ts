import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as zlib from 'zlib';

// Instance types for load testing
const COUCHBASE_INSTANCE_TYPE = 'c6i.xlarge';
const FHIR_SERVER_INSTANCE_TYPE = 'c6i.xlarge';

export class CouchbaseFhirVMStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly keyPair: ec2.KeyPair;
  public readonly couchbaseInstance: ec2.Instance;
  public readonly fhirServerInstance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use deterministic IDs based on stack name to prevent re-creation on every deploy
    const couchbaseId = `couchbase-stack`;
    const fhirServerId = `fhir-server-couchbase-stack`;

    // VPC with public and private subnets
    // FHIR Server in public subnet with public IP
    // Couchbase in private subnet (no public IP)
    this.vpc = new ec2.Vpc(this, 'CouchbaseFhirVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // VPC Endpoints for SSM Session Manager (required for private instances)
    // Security group for VPC endpoints
    const vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for VPC endpoints',
      allowAllOutbound: true,
    });
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'Allow HTTPS from VPC for SSM'
    );

    // SSM VPC Endpoint
    this.vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
    });

    // SSM Messages VPC Endpoint (required for Session Manager)
    this.vpc.addInterfaceEndpoint('SsmMessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
    });

    // EC2 Messages VPC Endpoint (required for Session Manager)
    this.vpc.addInterfaceEndpoint('Ec2MessagesEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
    });

    // CloudWatch Logs VPC Endpoint (for SSM session logging)
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [vpcEndpointSecurityGroup],
    });

    // Security group for Couchbase
    const couchbaseSecurityGroup = new ec2.SecurityGroup(this, 'CouchbaseSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for Couchbase instance ${couchbaseId}`,
      allowAllOutbound: true,
    });
    cdk.Tags.of(couchbaseSecurityGroup).add('Name', couchbaseId);
    cdk.Tags.of(couchbaseSecurityGroup).add('InstanceId', couchbaseId);

    // Allow all access from anywhere in VPC
    couchbaseSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all traffic from VPC'
    );

    // Allow public access to Couchbase Web Console (port 8091)
    couchbaseSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8091),
      'Allow public access to Couchbase Web Console'
    );

    // Allow SSH access to Couchbase
    couchbaseSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access'
    );

    // Security group for FHIR Server
    const fhirServerSecurityGroup = new ec2.SecurityGroup(this, 'FhirServerSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for FHIR Server instance ${fhirServerId}`,
      allowAllOutbound: true,
    });
    cdk.Tags.of(fhirServerSecurityGroup).add('Name', fhirServerId);
    cdk.Tags.of(fhirServerSecurityGroup).add('InstanceId', fhirServerId);

    // Allow all access from anywhere in VPC
    fhirServerSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow all traffic from VPC'
    );

    // Public ingress for FHIR Server backend (8080) and frontend (80)
    fhirServerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow public access to FHIR Server backend port 8080'
    );

    fhirServerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow public access to FHIR Server frontend port 80'
    );

    // Allow SSH access to FHIR Server
    fhirServerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access'
    );

    // Generate SSH key pair
    this.keyPair = new ec2.KeyPair(this, 'CouchbaseFhirKeyPair', {
      keyPairName: `couchbase-fhir-loadtest-key`,
      type: ec2.KeyPairType.RSA,
      format: ec2.KeyPairFormat.PEM,
    });

    // CloudWatch Log Groups with 3-day retention
    const couchbaseLogGroup = new logs.LogGroup(this, 'CouchbaseLogGroup', {
      logGroupName: `/aws/ec2/${couchbaseId}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(couchbaseLogGroup).add('InstanceId', couchbaseId);

    const fhirServerLogGroup = new logs.LogGroup(this, 'FhirServerLogGroup', {
      logGroupName: `/aws/ec2/${fhirServerId}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(fhirServerLogGroup).add('InstanceId', fhirServerId);

    // IAM role for Couchbase instance
    const couchbaseRole = new iam.Role(this, 'CouchbaseEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    couchbaseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:CreateLogGroup',
        ],
        resources: ['arn:aws:logs:*:*:*'],
      })
    );

    // Allow Couchbase to access S3 for backups
    couchbaseRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
        ],
        resources: [
          'arn:aws:s3:::hapi-loadtest-pg-backup',
          'arn:aws:s3:::hapi-loadtest-pg-backup/*',
        ],
      })
    );

    // IAM role for FHIR Server instance
    const fhirServerRole = new iam.Role(this, 'FhirServerEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    fhirServerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:CreateLogGroup',
        ],
        resources: ['arn:aws:logs:*:*:*'],
      })
    );

    // Allow FHIR Server to describe instances to discover Couchbase IP
    fhirServerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      })
    );

    // Allow FHIR Server to access S3 for backups and data
    fhirServerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
        ],
        resources: [
          'arn:aws:s3:::hapi-loadtest-pg-backup',
          'arn:aws:s3:::hapi-loadtest-pg-backup/*',
        ],
      })
    );

    // Get latest Amazon Linux 2023 AMI
    const ami = ec2.MachineImage.fromSsmParameter(
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      { os: ec2.OperatingSystemType.LINUX }
    );

    // ========================================================================
    // Couchbase Instance
    // ========================================================================

    const couchbaseUserData = ec2.UserData.forLinux();
    couchbaseUserData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      '',
      '# Create log files FIRST',
      'touch /var/log/user-data.log',
      'touch /var/log/couchbase-health.log',
      '',
      '# Logging setup',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "Starting Couchbase installation and configuration"',
      '',
      '# Ensure SSM Agent is installed and running',
      'echo "Ensuring SSM Agent is running..."',
      'REGION=$(ec2-metadata --availability-zone | sed "s/placement: //; s/.$//")',
      'sudo yum install -y "https://s3.${REGION}.amazonaws.com/amazon-ssm-${REGION}/latest/linux_amd64/amazon-ssm-agent.rpm"',
      'systemctl enable amazon-ssm-agent',
      'systemctl start amazon-ssm-agent',
      'systemctl status amazon-ssm-agent --no-pager',
      '',
      '# Install CloudWatch Agent',
      'echo "Installing CloudWatch Agent..."',
      'dnf install -y amazon-cloudwatch-agent',
      '',
      '# Configure CloudWatch Agent',
      'INSTANCE_ID="$(ec2-metadata --instance-id | cut -d " " -f 2)"',
      'cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<EOF',
      '{',
      '  "agent": {',
      `    "region": "${this.region}",`,
      '    "metrics_collection_interval": 60,',
      '    "run_as_user": "root"',
      '  },',
      '  "logs": {',
      '    "logs_collected": {',
      '      "files": {',
      '        "collect_list": [',
      '          {',
      '            "file_path": "/var/log/user-data.log",',
      `            "log_group_name": "/aws/ec2/${couchbaseId}",`,
      '            "log_stream_name": "user-data",',
      '            "retention_in_days": 3',
      '          },',
      '          {',
      '            "file_path": "/var/log/couchbase-health.log",',
      `            "log_group_name": "/aws/ec2/${couchbaseId}",`,
      '            "log_stream_name": "health-check",',
      '            "timezone": "UTC",',
      '            "retention_in_days": 3',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  },',
      '  "metrics": {',
      '    "namespace": "CouchbaseFhirLoadTest",',
      '    "metrics_collected": {',
      '      "cpu": {',
      '        "measurement": [',
      '          {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},',
      '          {"name": "cpu_usage_active", "rename": "CPU_ACTIVE", "unit": "Percent"},',
      '          {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"}',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "totalcpu": true',
      '      },',
      '      "mem": {',
      '        "measurement": [',
      '          {"name": "mem_used_percent", "rename": "MEM_USED_PERCENT", "unit": "Percent"}',
      '        ],',
      '        "metrics_collection_interval": 60',
      '      },',
      '      "disk": {',
      '        "measurement": [',
      '          {"name": "used_percent", "rename": "DISK_USED", "unit": "Percent"}',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "resources": ["*"]',
      '      }',
      '    },',
      '    "aggregation_dimensions": [["InstanceId"]],',
      '    "append_dimensions": {',
      '      "InstanceId": "${INSTANCE_ID}",',
      `      "InstanceType": "${COUCHBASE_INSTANCE_TYPE}",`,
      '      "Service": "Couchbase"',
      '    }',
      '  }',
      '}',
      'EOF',
      '',
      '# Start CloudWatch Agent',
      'echo "Starting CloudWatch Agent..."',
      '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\',
      '  -a fetch-config \\',
      '  -m ec2 \\',
      '  -s \\',
      '  -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json',
      'systemctl enable amazon-cloudwatch-agent',
      'systemctl restart amazon-cloudwatch-agent',
      'sleep 2',
      'systemctl is-active amazon-cloudwatch-agent || {',
      '  echo "CloudWatch Agent failed to start"',
      '  journalctl -u amazon-cloudwatch-agent -n 50',
      '  exit 1',
      '}',
      '',
      '# Download and install Couchbase Server Community Edition using official method',
      'echo "Installing Couchbase Server Community Edition..."',
      '',
      '# Download the meta package',
      'echo "Downloading Couchbase release meta package..."',
      'curl -O https://packages.couchbase.com/releases/couchbase-release/couchbase-release-1.0.noarch.rpm',
      '',
      '# Install the meta package',
      'echo "Installing Couchbase release meta package..."',
      'rpm -i ./couchbase-release-1.0.noarch.rpm',
      '',
      '# Install Couchbase Server Community Edition',
      'echo "Installing Couchbase Server Community Edition..."',
      'yum install -y couchbase-server',
      '',
      '# Verify installation',
      'rpm -qi couchbase-server || { echo "Couchbase installation failed"; exit 1; }',
      '',
      '# Wait for Couchbase to start',
      'echo "Waiting for Couchbase to start..."',
      'sleep 30',
      '',
      '# Get instance private IP',
      'PRIVATE_IP=$(ec2-metadata --local-ipv4 | cut -d " " -f 2)',
      'echo "Instance private IP: $PRIVATE_IP"',
      '',
      '# Initialize Couchbase cluster (optimized for c6i.xlarge: 4 vCPU, 8 GB RAM)',
      'echo "Initializing Couchbase cluster..."',
      '/opt/couchbase/bin/couchbase-cli cluster-init \\',
      '  --cluster $PRIVATE_IP \\',
      '  --cluster-username Administrator \\',
      '  --cluster-password P@ssw0rd \\',
      '  --services data,index,query,fts \\',
      '  --cluster-ramsize 3072 \\',
      '  --cluster-index-ramsize 768 \\',
      '  --cluster-fts-ramsize 512 \\',
      '  --index-storage-setting default',
      '',
      'echo "Waiting for cluster to be ready..."',
      'sleep 10',
      '',
      '# Create fhir bucket with couchstore backend (Community Edition)',
      'echo "Creating fhir bucket..."',
      '/opt/couchbase/bin/couchbase-cli bucket-create \\',
      '  --cluster $PRIVATE_IP \\',
      '  --username Administrator \\',
      '  --password P@ssw0rd \\',
      '  --bucket fhir \\',
      '  --bucket-type couchbase \\',
      '  --bucket-ramsize 2048 \\',
      '  --bucket-replica 0 \\',
      '  --durability-min-level persistToMajority \\',
      '  --enable-flush 1 \\',
      '  --storage-backend couchstore',
      '',
      'echo "Waiting for bucket to be ready..."',
      'sleep 10',
      '',
      '# Health check loop',
      'echo "Starting health check loop..." | tee -a /var/log/couchbase-health.log',
      'HEALTH_CHECK_COUNT=0',
      'MAX_RETRIES=30',
      'while [ $HEALTH_CHECK_COUNT -lt $MAX_RETRIES ]; do',
      '  if /opt/couchbase/bin/couchbase-cli server-info \\',
      '      --cluster $PRIVATE_IP \\',
      '      --username Administrator \\',
      '      --password P@ssw0rd > /dev/null 2>&1; then',
      '    echo "$(date): Couchbase health check PASSED" | tee -a /var/log/couchbase-health.log',
      '    echo "Couchbase is ready and accepting connections" | tee -a /var/log/couchbase-health.log',
      '    break',
      '  else',
      '    echo "$(date): Couchbase health check attempt $((HEALTH_CHECK_COUNT+1))/$MAX_RETRIES" | tee -a /var/log/couchbase-health.log',
      '    HEALTH_CHECK_COUNT=$((HEALTH_CHECK_COUNT+1))',
      '    sleep 20',
      '  fi',
      'done',
      '',
      'if [ $HEALTH_CHECK_COUNT -eq $MAX_RETRIES ]; then',
      '  echo "$(date): Couchbase health check FAILED after $MAX_RETRIES attempts" | tee -a /var/log/couchbase-health.log',
      '  exit 1',
      'fi',
      '',
      'echo "Couchbase setup completed successfully"',
    );

    this.couchbaseInstance = new ec2.Instance(this, 'CouchbaseInstance', {
      instanceType: new ec2.InstanceType(COUCHBASE_INSTANCE_TYPE),
      machineImage: ami,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: couchbaseSecurityGroup,
      role: couchbaseRole,
      userData: couchbaseUserData,
      keyPair: this.keyPair,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    cdk.Tags.of(this.couchbaseInstance).add('Name', couchbaseId);
    cdk.Tags.of(this.couchbaseInstance).add('Service', 'Couchbase');

    // ========================================================================
    // FHIR Server Instance
    // ========================================================================

    // FHIR Server User Data Script - Compressed with gzip+base64 to fit within 16KB limit
    const fhirServerScriptContent = `#!/bin/bash
set -euxo pipefail

# Create log files FIRST
touch /var/log/user-data.log
touch /var/log/fhir-build.log
touch /var/log/fhir-server.log
touch /var/log/fhir-health.log

# Logging setup
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "Starting FHIR Server installation and configuration"

# Ensure SSM Agent is installed and running
echo "Ensuring SSM Agent is running..."
REGION=$(ec2-metadata --availability-zone | sed "s/placement: //; s/.$//")
sudo yum install -y "https://s3.\${REGION}.amazonaws.com/amazon-ssm-\${REGION}/latest/linux_amd64/amazon-ssm-agent.rpm"
systemctl enable amazon-ssm-agent
systemctl start amazon-ssm-agent
systemctl status amazon-ssm-agent --no-pager

# Install CloudWatch Agent
echo "Installing CloudWatch Agent..."
dnf install -y amazon-cloudwatch-agent

# Configure CloudWatch Agent
INSTANCE_ID="$(ec2-metadata --instance-id | cut -d " " -f 2)"
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<EOFCW
{
  "agent": {
    "region": "${this.region}",
    "metrics_collection_interval": 60
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/user-data.log",
            "log_group_name": "/aws/ec2/${fhirServerId}",
            "log_stream_name": "user-data",
            "timezone": "UTC",
            "retention_in_days": 3
          },
          {
            "file_path": "/var/log/fhir-build.log",
            "log_group_name": "/aws/ec2/${fhirServerId}",
            "log_stream_name": "build",
            "timezone": "UTC",
            "retention_in_days": 3
          },
          {
            "file_path": "/var/log/fhir-server.log",
            "log_group_name": "/aws/ec2/${fhirServerId}",
            "log_stream_name": "server",
            "timezone": "UTC",
            "retention_in_days": 3
          },
          {
            "file_path": "/var/log/fhir-health.log",
            "log_group_name": "/aws/ec2/${fhirServerId}",
            "log_stream_name": "health-check",
            "timezone": "UTC",
            "retention_in_days": 3
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "CouchbaseFhirLoadTest",
    "metrics_collected": {
      "cpu": {
        "measurement": [
          {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},
          {"name": "cpu_usage_active", "rename": "CPU_ACTIVE", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60,
        "totalcpu": true
      },
      "mem": {
        "measurement": [
          {"name": "mem_used_percent", "rename": "MEM_USED_PERCENT", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60
      }
    },
    "aggregation_dimensions": [["InstanceId"]],
    "append_dimensions": {
      "InstanceId": "\${INSTANCE_ID}",
      "InstanceType": "${FHIR_SERVER_INSTANCE_TYPE}",
      "Service": "FhirServer"
    }
  }
}
EOFCW

# Start CloudWatch Agent
echo "Starting CloudWatch Agent..."
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\
  -a fetch-config \\
  -m ec2 \\
  -s \\
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json
systemctl enable amazon-cloudwatch-agent
systemctl restart amazon-cloudwatch-agent
sleep 2
systemctl is-active amazon-cloudwatch-agent || {
  echo "CloudWatch Agent failed to start"
  journalctl -u amazon-cloudwatch-agent -n 50
  exit 1
}

# Discover Couchbase instance IP using AWS CLI (runtime discovery like HAPI does for PostgreSQL)
echo "Discovering Couchbase instance..."

# Get IMDSv2 token
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)

# Get this instance's VPC ID from metadata service
INSTANCE_MAC=$(curl -H "X-aws-ec2-metadata-token: \$TOKEN" -s http://169.254.169.254/latest/meta-data/mac)
echo "Instance MAC address: \$INSTANCE_MAC"

VPC_ID=$(curl -H "X-aws-ec2-metadata-token: \$TOKEN" -s "http://169.254.169.254/latest/meta-data/network/interfaces/macs/\$INSTANCE_MAC/vpc-id")
echo "This instance is in VPC: \$VPC_ID"

COUCHBASE_HOST=$(aws ec2 describe-instances --region ${this.region} --filters "Name=tag:Service,Values=Couchbase" "Name=vpc-id,Values=\$VPC_ID" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)
echo "Found Couchbase at: \$COUCHBASE_HOST"

if [ -z "\$COUCHBASE_HOST" ] || [ "\$COUCHBASE_HOST" = "None" ]; then
  echo "ERROR: Could not discover Couchbase instance IP"
  exit 1
fi

# Install dependencies: Java 21, Git, Maven, Node.js, HAProxy
echo "Installing dependencies..."
dnf install -y java-21-amazon-corretto-devel git maven haproxy wget

# Configure swap space (2GB) to prevent OOM during build
echo "Configuring swap space..."
dd if=/dev/zero of=/swapfile bs=128M count=16
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
free -h

# Install Node.js 20 using nvm for the ec2-user
echo "Installing Node.js..."
su - ec2-user -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
su - ec2-user -c "source ~/.nvm/nvm.sh && nvm install 20"
su - ec2-user -c "source ~/.nvm/nvm.sh && nvm alias default 20"
su - ec2-user -c "source ~/.nvm/nvm.sh && node --version"
su - ec2-user -c "source ~/.nvm/nvm.sh && npm --version"

# Clone Couchbase FHIR CE repository (pinned to v0.9.201)
echo "Cloning Couchbase FHIR CE repository (v0.9.201)..."
su - ec2-user <<'EOFGIT'
set -euxo pipefail
cd ~
git clone --depth 1 https://github.com/couchbaselabs/couchbase-fhir-ce.git
cd couchbase-fhir-ce
echo "Cloned version: $(git describe --tags)"
EOFGIT

# Create config.yaml
echo "Creating config.yaml..."
PUBLIC_IP=$(ec2-metadata --public-ipv4 | cut -d " " -f 2)
cat > /home/ec2-user/couchbase-fhir-ce/config.yaml <<EOFCONFIG
app:
  autoConnect: true
  security:
    use-keycloak: false
  cors:
    allowedOrigins: "http://localhost:4000,http://localhost:8081,http://\${PUBLIC_IP}:8081"
    allowedMethods: "GET,POST,PUT,DELETE,OPTIONS"
    allowedHeaders: "*"
    allowCredentials: true

couchbase:
  connection:
    connectionString: "\${COUCHBASE_HOST}"
    username: "Administrator"
    password: "P@ssw0rd"
    serverType: "Server"
    sslEnabled: false
  bucket:
    name: "fhir"
    fhirRelease: "R4"
    validation:
      mode: "lenient"
      profile: "us-core"

logging:
  levels:
    com.couchbase.admin: INFO
    com.couchbase.fhir: INFO
    com.couchbase.common: WARN

admin:
  email: "admin@example.com"
  password: "Admin123!"
  name: "Admin"
  tls:
    enabled: false
EOFCONFIG

# Build FHIR Server Backend
echo "Building FHIR Server Backend (this will take 5-10 minutes)..." | tee -a /var/log/fhir-build.log
su - ec2-user <<'EOFBUILD' 2>&1 | tee -a /var/log/fhir-build.log
set -euxo pipefail
export JAVA_HOME=/usr/lib/jvm/java-21-amazon-corretto
export PATH=$JAVA_HOME/bin:$PATH
java -version
cd ~/couchbase-fhir-ce/backend
echo "Running Maven clean package..."
mvn clean package -DskipTests
EOFBUILD

# Build FHIR Server Frontend
echo "Building FHIR Server Frontend (this will take 2-3 minutes)..." | tee -a /var/log/fhir-build.log
su - ec2-user <<'EOFFRONTEND' 2>&1 | tee -a /var/log/fhir-build.log
set -euxo pipefail
source ~/.nvm/nvm.sh
cd ~/couchbase-fhir-ce/frontend
echo "Installing npm dependencies..."
npm ci --silent
echo "Building frontend application..."
npm run build
ls -lh dist/
EOFFRONTEND

# Create logs directory and set permissions
mkdir -p /home/ec2-user/couchbase-fhir-ce/backend/logs
chown -R ec2-user:ec2-user /home/ec2-user/couchbase-fhir-ce

# Download OpenTelemetry Java agent
echo "Downloading OpenTelemetry Java agent..."
cd /home/ec2-user/couchbase-fhir-ce/backend
wget https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar
chown ec2-user:ec2-user /home/ec2-user/couchbase-fhir-ce/backend/opentelemetry-javaagent.jar

# Create systemd service for FHIR Server Backend
# Find the exact JAR file name to avoid wildcard issues
JAR_FILE=$(find /home/ec2-user/couchbase-fhir-ce/backend/target -name "*.jar")
echo "Found JAR file: $JAR_FILE"
cat > /etc/systemd/system/fhir-server.service <<EOFSVC
[Unit]
Description=FHIR Server Backend
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/couchbase-fhir-ce/backend
Environment="SPRING_PROFILES_ACTIVE=prod"
Environment="DEPLOYED_ENV=container"
Environment="SERVER_TOMCAT_THREADS_MAX=500"
Environment="SERVER_TOMCAT_THREADS_MIN_SPARE=50"
Environment="SERVER_TOMCAT_ACCEPT_COUNT=500"
Environment="SERVER_TOMCAT_MAX_CONNECTIONS=8192"
Environment="SERVER_TOMCAT_CONNECTION_TIMEOUT=20s"
Environment="SERVER_TOMCAT_MAX_KEEP_ALIVE_REQUESTS=500"

# OpenTelemetry Configuration
Environment="OTEL_SERVICE_NAME=couchbase-fhir-ce"

Environment="OTEL_TRACES_SAMPLER=always_on"
Environment="OTEL_METRICS_EXPORTER=otlp"
Environment="OTEL_LOGS_EXPORTER=otlp"
Environment="OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_MICROMETER_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_SPRING_WEBMVC_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_SPRING_WEB_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_SERVLET_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_TOMCAT_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_JDBC_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_JDBC_DATASOURCE_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_HIKARICP_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_HIBERNATE_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_JPA_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_SPRING_DATA_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_EXECUTORS_ENABLED=true"
Environment="OTEL_INSTRUMENTATION_METHODS_ENABLED=true"
Environment="OTEL_JAVAAGENT_DEBUG=false"

ExecStart=/usr/lib/jvm/java-21-amazon-corretto/bin/java \\
    -javaagent:/home/ec2-user/couchbase-fhir-ce/backend/opentelemetry-javaagent.jar \\
    -Xms4096m \\
    -Xmx6432m \\
    -Xss512k \\
    -XX:MaxDirectMemorySize=256m \\
    -XX:+UseG1GC \\
    -XX:MaxGCPauseMillis=200 \\
    -XX:+HeapDumpOnOutOfMemoryError \\
    -XX:HeapDumpPath=/home/ec2-user/couchbase-fhir-ce/backend/logs/heap.hprof \\
    -XX:+ExitOnOutOfMemoryError \\
    -Xlog:gc*:file=/home/ec2-user/couchbase-fhir-ce/backend/logs/gc.log:time,uptime,level,tags:filecount=5,filesize=10M \\
    -jar \${JAR_FILE} \\
    --spring.config.additional-location=file:/home/ec2-user/couchbase-fhir-ce/config.yaml
Restart=always
RestartSec=10
StandardOutput=append:/var/log/fhir-server.log
StandardError=append:/var/log/fhir-server.log

[Install]
WantedBy=multi-user.target
EOFSVC

# Create systemd service for Vite Frontend Server
cat > /etc/systemd/system/frontend-server.service <<'EOFFRONTSVC'
[Unit]
Description=Vite Preview Frontend Server
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/couchbase-fhir-ce/frontend
ExecStart=/bin/bash -c "source /home/ec2-user/.nvm/nvm.sh && npm run preview -- --host 0.0.0.0 --port 3000"
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOFFRONTSVC

# Configure HAProxy
echo "Configuring HAProxy..."
cat > /etc/haproxy/haproxy.cfg <<'EOFPROXY'
global
    log /dev/log local0
    log /dev/log local1 notice
    chroot /var/lib/haproxy
    stats timeout 30s
    user haproxy
    group haproxy
    daemon

defaults
    log global
    mode http
    option httplog
    option dontlognull
    timeout connect 5000
    timeout client 50000
    timeout server 50000

frontend http-in
    bind *:80
    acl url_fhir path_beg /fhir /api /health
    use_backend fhir-be if url_fhir
    default_backend ui-be

backend fhir-be
    server fhir-1 127.0.0.1:8080

backend ui-be
    server ui-1 127.0.0.1:3000
EOFPROXY

# Check HAProxy config and start
haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl enable haproxy
systemctl start haproxy

# Wait for Couchbase to be reachable BEFORE starting backend
echo "Waiting for Couchbase to be reachable before starting FHIR backend..."
RETRY_COUNT=0
MAX_RETRIES=60
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if timeout 2 bash -c "</dev/tcp/$COUCHBASE_HOST/8091"; then
    echo "Couchbase is reachable"
    break
  fi
  echo "Attempt $((RETRY_COUNT+1))/$MAX_RETRIES - Couchbase not ready yet, waiting..."
  RETRY_COUNT=$((RETRY_COUNT+1))
  sleep 10
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "ERROR: Couchbase not reachable after $MAX_RETRIES attempts"
  exit 1
fi

# Start services
echo "Starting FHIR Backend and Frontend services..."
systemctl daemon-reload
systemctl enable fhir-server
systemctl start fhir-server
systemctl enable frontend-server
systemctl start frontend-server

# Wait for FHIR Server Backend to be ready
echo "Waiting for FHIR Server Backend to be ready..." | tee -a /var/log/fhir-health.log
HEALTH_CHECK_COUNT=0
MAX_RETRIES=120
while [ $HEALTH_CHECK_COUNT -lt $MAX_RETRIES ]; do
  if curl -f -s http://localhost:8080/fhir/metadata > /dev/null 2>&1; then
    echo "$(date): FHIR Backend (8080) health check PASSED" | tee -a /var/log/fhir-health.log
    break
  else
    echo "$(date): FHIR Backend health check attempt $((HEALTH_CHECK_COUNT+1))/$MAX_RETRIES" | tee -a /var/log/fhir-health.log
    HEALTH_CHECK_COUNT=$((HEALTH_CHECK_COUNT+1))
    sleep 10
  fi
done

if [ $HEALTH_CHECK_COUNT -eq $MAX_RETRIES ]; then
  echo "$(date): FHIR Backend health check FAILED" | tee -a /var/log/fhir-health.log
  systemctl status fhir-server --no-pager
  tail -100 /var/log/fhir-server.log
  exit 1
fi

# Wait for frontend to be ready via HAProxy
echo "Waiting for FHIR Frontend (HAProxy) to be ready..." | tee -a /var/log/fhir-health.log
HEALTH_CHECK_COUNT=0
MAX_RETRIES=30
while [ $HEALTH_CHECK_COUNT -lt $MAX_RETRIES ]; do
  if curl -f -s -L http://localhost:80 > /dev/null 2>&1; then
    echo "$(date): FHIR Frontend (80) health check PASSED" | tee -a /var/log/fhir-health.log
    break
  else
    echo "$(date): FHIR Frontend health check attempt $((HEALTH_CHECK_COUNT+1))/$MAX_RETRIES" | tee -a /var/log/fhir-health.log
    HEALTH_CHECK_COUNT=$((HEALTH_CHECK_COUNT+1))
    sleep 5
  fi
done

if [ $HEALTH_CHECK_COUNT -eq $MAX_RETRIES ]; then
  echo "$(date): FHIR Frontend health check FAILED" | tee -a /var/log/fhir-health.log
  systemctl status haproxy --no-pager
  systemctl status frontend-server --no-pager
  exit 1
fi

echo "FHIR Server setup completed successfully"
echo "  - Backend API and Frontend UI available via HAProxy on port 80"
echo "  - Version: v0.9.201"
echo "  - OpenTelemetry instrumentation enabled"
`;

    // Compress and base64 encode the script
    const compressedFhirServerScript = zlib.gzipSync(Buffer.from(fhirServerScriptContent)).toString('base64');

    // Create minimal bootstrap user data that decompresses and runs the script
    const fhirServerUserData = ec2.UserData.forLinux();
    fhirServerUserData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      `echo "${compressedFhirServerScript}" | base64 -d | gunzip > /tmp/fhir-server-setup.sh`,
      'chmod +x /tmp/fhir-server-setup.sh',
      '/tmp/fhir-server-setup.sh',
    );

    this.fhirServerInstance = new ec2.Instance(this, 'FhirServerInstance', {
      instanceType: new ec2.InstanceType(FHIR_SERVER_INSTANCE_TYPE),
      machineImage: ami,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: fhirServerSecurityGroup,
      role: fhirServerRole,
      userData: fhirServerUserData,
      keyPair: this.keyPair,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    cdk.Tags.of(this.fhirServerInstance).add('Name', fhirServerId);
    cdk.Tags.of(this.fhirServerInstance).add('Service', 'FhirServer');

    // Add dependency - FHIR Server should deploy after Couchbase
    this.fhirServerInstance.node.addDependency(this.couchbaseInstance);

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'CouchbasePrivateIP', {
      value: this.couchbaseInstance.instancePrivateIp,
      description: 'Couchbase private IP address',
    });

    new cdk.CfnOutput(this, 'CouchbasePublicIP', {
      value: this.couchbaseInstance.instancePublicIp,
      description: 'Couchbase public IP address',
    });

    new cdk.CfnOutput(this, 'CouchbaseConsoleURL', {
      value: `http://${this.couchbaseInstance.instancePublicIp}:8091/`,
      description: 'Couchbase Web Console URL (public access)',
    });

    new cdk.CfnOutput(this, 'FhirServerPrivateIP', {
      value: this.fhirServerInstance.instancePrivateIp,
      description: 'FHIR Server private IP (used by Locust for load testing)',
    });

    new cdk.CfnOutput(this, 'FhirServerPublicIP', {
      value: this.fhirServerInstance.instancePublicIp,
      description: 'FHIR Server public IP address',
    });

    new cdk.CfnOutput(this, 'FhirFrontendURL', {
      value: `http://${this.fhirServerInstance.instancePublicIp}`,
      description: 'FHIR Admin UI (Frontend - port 80)',
    });

    new cdk.CfnOutput(this, 'FhirBackendURL', {
      value: `http://${this.fhirServerInstance.instancePublicIp}:8080/`,
      description: 'FHIR Server API (Backend - port 8080)',
    });

    new cdk.CfnOutput(this, 'FhirMetadataURL', {
      value: `http://${this.fhirServerInstance.instancePublicIp}:8080/fhir/metadata`,
      description: 'FHIR Server Metadata Endpoint',
    });

    new cdk.CfnOutput(this, 'FhirServerPrivateURL', {
      value: `http://${this.fhirServerInstance.instancePrivateIp}:8080/`,
      description: 'FHIR Server private URL (for load testing)',
    });

    new cdk.CfnOutput(this, 'KeyPairName', {
      value: this.keyPair.keyPairName,
      description: 'SSH key pair name',
    });

    new cdk.CfnOutput(this, 'SSHKeyPairId', {
      value: this.keyPair.keyPairId,
      description: 'SSH key pair ID (for SSM parameter)',
    });

    new cdk.CfnOutput(this, 'CouchbaseInstanceId', {
      value: this.couchbaseInstance.instanceId,
      description: 'Couchbase EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'FhirServerInstanceId', {
      value: this.fhirServerInstance.instanceId,
      description: 'FHIR Server EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'CouchbaseSSHCommand', {
      value: `ssh -i infra/keys/couchbase-fhir-loadtest-key.pem ec2-user@${this.couchbaseInstance.instancePublicIp}`,
      description: 'SSH command to connect to Couchbase instance',
    });

    new cdk.CfnOutput(this, 'FhirServerSSHCommand', {
      value: `ssh -i infra/keys/couchbase-fhir-loadtest-key.pem ec2-user@${this.fhirServerInstance.instancePublicIp}`,
      description: 'SSH command to connect to FHIR Server instance',
    });

    new cdk.CfnOutput(this, 'CouchbaseLogGroupOutput', {
      value: couchbaseLogGroup.logGroupName,
      description: `Couchbase CloudWatch Logs: https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/${encodeURIComponent(couchbaseLogGroup.logGroupName)}`,
    });

    new cdk.CfnOutput(this, 'FhirServerLogGroupOutput', {
      value: fhirServerLogGroup.logGroupName,
      description: `FHIR Server CloudWatch Logs: https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/${encodeURIComponent(fhirServerLogGroup.logGroupName)}`,
    });

    new cdk.CfnOutput(this, 'ArchitectureInfo', {
      value: 'Couchbase FHIR CE v0.9.201 | Frontend (React) on port 80 | Backend (Spring Boot) on port 8080 | Nginx proxies /api/* and /fhir/* to backend',
      description: 'Architecture Overview',
    });
  }
}

// Instantiate the stack
const app = new cdk.App();

new CouchbaseFhirVMStack(app, 'CouchbaseFhirVMStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-south-1',
  },
});
