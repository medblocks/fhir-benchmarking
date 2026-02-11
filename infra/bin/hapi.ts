import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as zlib from 'zlib';

// Hardcoded instance types for load testing
const POSTGRES_INSTANCE_TYPE = 'c6i.xlarge';
const HAPI_INSTANCE_TYPE = 'c6i.xlarge';

export class HapiStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly keyPair: ec2.KeyPair;
  public readonly hapiInstance: ec2.Instance;
  public readonly postgresInstance: ec2.Instance;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use deterministic IDs based on stack name to prevent re-creation on every deploy
    const postgresId = `postgres-hapi-stack`;
    const hapiId = `hapi-hapi-stack`;

    // VPC with public subnet for SSH access
    this.vpc = new ec2.Vpc(this, 'HapiVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Security group for PostgreSQL
    const postgresSecurityGroup = new ec2.SecurityGroup(this, 'PostgresSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for PostgreSQL instance ${postgresId}`,
      allowAllOutbound: true,
    });
    cdk.Tags.of(postgresSecurityGroup).add('Name', postgresId);
    cdk.Tags.of(postgresSecurityGroup).add('InstanceId', postgresId);

    // Security group for HAPI FHIR
    const hapiSecurityGroup = new ec2.SecurityGroup(this, 'HapiSecurityGroup', {
      vpc: this.vpc,
      description: `Security group for HAPI FHIR instance ${hapiId}`,
      allowAllOutbound: true,
    });
    cdk.Tags.of(hapiSecurityGroup).add('Name', hapiId);
    cdk.Tags.of(hapiSecurityGroup).add('InstanceId', hapiId);

    // Allow PostgreSQL access from anywhere in VPC (ephemeral load test - no security needed)
    postgresSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from VPC'
    );

    // Allow HAPI FHIR HTTP access from anywhere
    hapiSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow HAPI FHIR HTTP access'
    );

    // Allow SSH access to HAPI instance
    hapiSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH access'
    );

    // Generate SSH key pair
    this.keyPair = new ec2.KeyPair(this, 'HapiKeyPair', {
      keyPairName: `hapi-loadtest-key`,
      type: ec2.KeyPairType.RSA,
      format: ec2.KeyPairFormat.PEM,
    });

    // CloudWatch Log Groups with 3-day retention
    const postgresLogGroup = new logs.LogGroup(this, 'PostgresLogGroup', {
      logGroupName: `/aws/ec2/${postgresId}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(postgresLogGroup).add('InstanceId', postgresId);

    const hapiLogGroup = new logs.LogGroup(this, 'HapiLogGroup', {
      logGroupName: `/aws/ec2/${hapiId}`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    cdk.Tags.of(hapiLogGroup).add('InstanceId', hapiId);

    // IAM role for PostgreSQL instance
    const postgresRole = new iam.Role(this, 'PostgresEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    postgresRole.addToPrincipalPolicy(
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

    // IAM role for HAPI instance
    const hapiRole = new iam.Role(this, 'HapiEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    hapiRole.addToPrincipalPolicy(
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

    // Allow HAPI to describe instances to discover Postgres IP
    hapiRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      })
    );

    // Allow HAPI to access S3 for database backups
    hapiRole.addToPrincipalPolicy(
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
    
    // Allow HAPI to access S3 for database backups
    postgresRole.addToPrincipalPolicy(
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

    // PostgreSQL User Data Script
    const postgresUserData = ec2.UserData.forLinux();
    postgresUserData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      '',
      '# Logging setup',
      'exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1',
      'echo "Starting PostgreSQL installation and configuration"',
      '',
      '# Install PostgreSQL 16',
      'echo "Installing PostgreSQL 16..."',
      'dnf install -y postgresql16 postgresql16-server',
      '',
      '# Initialize PostgreSQL',
      'echo "Initializing PostgreSQL database..."',
      'postgresql-setup --initdb',
      '',
      '# Configure PostgreSQL for network access',
      'echo "Configuring PostgreSQL for network access..."',
      'sed -i "s/#listen_addresses = \'localhost\'/listen_addresses = \'*\'/" /var/lib/pgsql/data/postgresql.conf',
      '',
      'echo "max_connections = 200" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# Memory settings - tuned for c6i.2xlarge (16GB RAM)',
      'echo "shared_buffers = 2GB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "effective_cache_size = 6GB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "work_mem = 32MB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "maintenance_work_mem = 512MB" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# WAL settings for write-heavy HAPI workloads',
      'echo "wal_buffers = 64MB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "checkpoint_completion_target = 0.9" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "checkpoint_timeout = 15min" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "max_wal_size = 1GB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "min_wal_size = 200MB" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# Query planner settings for SSD/NVMe storage',
      'echo "random_page_cost = 1.1" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "effective_io_concurrency = 200" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# Parallel query settings',
      'echo "max_parallel_workers_per_gather = 2" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "max_parallel_workers = 4" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "max_parallel_maintenance_workers = 2" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# Configure PostgreSQL file logging for Grafana Alloy',
      'echo "Configuring PostgreSQL file logging..."',
      'echo "logging_collector = on" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_directory = \'/var/log/postgresql\'" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_filename = \'postgres.log\'" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_rotation_age = 1d" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_rotation_size = 100MB" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_truncate_on_rotation = on" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_line_prefix = \'%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h \'" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_connections = on" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_disconnections = on" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_duration = off" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_statement = \'none\'" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_min_duration_statement = 1000" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_checkpoints = on" >> /var/lib/pgsql/data/postgresql.conf',
      'echo "log_lock_waits = on" >> /var/lib/pgsql/data/postgresql.conf',
      '',
      '# Create PostgreSQL log directory with proper permissions (readable by Alloy)',
      'mkdir -p /var/log/postgresql',
      'chown postgres:postgres /var/log/postgresql',
      'chmod 755 /var/log/postgresql',
      '',
      '# Ensure log files will be readable by Alloy',
      'touch /var/log/postgresql/postgres.log',
      'chown postgres:postgres /var/log/postgresql/postgres.log',
      'chmod 644 /var/log/postgresql/postgres.log',
      '',
      '# Configure pg_hba.conf to allow password authentication (ephemeral load test)',
      'sed -i "s/127\\.0\\.0\\.1\\/32.*ident/127.0.0.1\\/32            md5/" /var/lib/pgsql/data/pg_hba.conf',
      'sed -i "s/::1\\/128.*ident/::1\\/128                 md5/" /var/lib/pgsql/data/pg_hba.conf',
      '# Allow remote connections',
      'echo "host    all             all             0.0.0.0/0               md5" >> /var/lib/pgsql/data/pg_hba.conf',
      '',
      '# Start and enable PostgreSQL',
      'echo "Starting PostgreSQL service..."',
      'systemctl enable postgresql',
      'systemctl start postgresql',
      '',
      '# Wait for PostgreSQL to be ready',
      'echo "Waiting for PostgreSQL to be ready..."',
      'sleep 5',
      '',
      '# Create hapi database and user',
      'echo "Creating hapi database and user..."',
      'sudo -u postgres psql -c "CREATE DATABASE hapi;"',
      'sudo -u postgres psql -c "CREATE USER hapi WITH PASSWORD \'hapi\';"',
      'sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hapi TO hapi;"',
      'sudo -u postgres psql -c "ALTER DATABASE hapi OWNER TO hapi;"',
      'sudo -u postgres psql -c "GRANT pg_monitor TO hapi;"',
      '',
      '# Install CloudWatch Agent',
      'echo "Installing CloudWatch Agent..."',
      'dnf install -y amazon-cloudwatch-agent',
      '',
      '# Create log files before CloudWatch Agent starts',
      'touch /var/log/user-data.log',
      'touch /var/log/postgres-health.log',
      'mkdir -p /var/log/postgresql',
      '',
      '# Configure CloudWatch Agent',
      '# Get instance ID using IMDSv2 (required for Amazon Linux 2023)',
      'TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)',
      'INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)',
      'echo "Instance ID: $INSTANCE_ID"',
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
      `            "log_group_name": "/aws/ec2/${postgresId}",`,
      '            "log_stream_name": "user-data",',
      '            "timezone": "UTC",',
      '            "retention_in_days": 3',
      '          },',
      '          {',
      '            "file_path": "/var/log/postgres-health.log",',
      `            "log_group_name": "/aws/ec2/${postgresId}",`,
      '            "log_stream_name": "health-check",',
      '            "timezone": "UTC",',
      '            "retention_in_days": 3',
      '          }',
      '        ]',
      '      }',
      '    }',
      '  },',
      '  "metrics": {',
      '    "namespace": "HapiLoadTest",',
      '    "metrics_collected": {',
      '      "cpu": {',
      '        "measurement": [',
      '          {',
      '            "name": "cpu_usage_idle",',
      '            "rename": "CPU_IDLE",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "cpu_usage_active",',
      '            "rename": "CPU_ACTIVE",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "cpu_usage_iowait",',
      '            "rename": "CPU_IOWAIT",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "cpu_usage_system",',
      '            "rename": "CPU_SYSTEM",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "cpu_usage_user",',
      '            "rename": "CPU_USER",',
      '            "unit": "Percent"',
      '          }',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "totalcpu": true',
      '      },',
      '      "disk": {',
      '        "measurement": [',
      '          {',
      '            "name": "used_percent",',
      '            "rename": "DISK_USED",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "inodes_free",',
      '            "rename": "DISK_INODES_FREE",',
      '            "unit": "Count"',
      '          }',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "resources": ["*"]',
      '      },',
      '      "diskio": {',
      '        "measurement": [',
      '          {',
      '            "name": "io_time",',
      '            "rename": "DISKIO_TIME",',
      '            "unit": "Milliseconds"',
      '          },',
      '          {',
      '            "name": "read_bytes",',
      '            "rename": "DISKIO_READ_BYTES",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "write_bytes",',
      '            "rename": "DISKIO_WRITE_BYTES",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "reads",',
      '            "rename": "DISKIO_READS",',
      '            "unit": "Count"',
      '          },',
      '          {',
      '            "name": "writes",',
      '            "rename": "DISKIO_WRITES",',
      '            "unit": "Count"',
      '          }',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "resources": ["*"]',
      '      },',
      '      "mem": {',
      '        "measurement": [',
      '          {',
      '            "name": "mem_used_percent",',
      '            "rename": "MEM_USED_PERCENT",',
      '            "unit": "Percent"',
      '          },',
      '          {',
      '            "name": "mem_available",',
      '            "rename": "MEM_AVAILABLE",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "mem_used",',
      '            "rename": "MEM_USED",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "mem_total",',
      '            "rename": "MEM_TOTAL",',
      '            "unit": "Bytes"',
      '          }',
      '        ],',
      '        "metrics_collection_interval": 60',
      '      },',
      '      "netstat": {',
      '        "measurement": [',
      '          "tcp_established",',
      '          "tcp_time_wait"',
      '        ],',
      '        "metrics_collection_interval": 60',
      '      },',
      '      "net": {',
      '        "measurement": [',
      '          {',
      '            "name": "bytes_sent",',
      '            "rename": "NET_BYTES_SENT",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "bytes_recv",',
      '            "rename": "NET_BYTES_RECEIVED",',
      '            "unit": "Bytes"',
      '          },',
      '          {',
      '            "name": "packets_sent",',
      '            "rename": "NET_PACKETS_SENT",',
      '            "unit": "Count"',
      '          },',
      '          {',
      '            "name": "packets_recv",',
      '            "rename": "NET_PACKETS_RECEIVED",',
      '            "unit": "Count"',
      '          }',
      '        ],',
      '        "metrics_collection_interval": 60,',
      '        "resources": ["*"]',
      '      }',
      '    },',
      '    "aggregation_dimensions": [',
      '      ["InstanceId"]',
      '    ],',
      '    "append_dimensions": {',
      '      "InstanceId": "${INSTANCE_ID}",',
      `      "InstanceType": "${POSTGRES_INSTANCE_TYPE}",`,
      '      "Service": "PostgreSQL"',
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
      '',
      '# Health check loop',
      'echo "Starting health check loop..." | tee -a /var/log/postgres-health.log',
      'HEALTH_CHECK_COUNT=0',
      'MAX_RETRIES=30',
      'while [ $HEALTH_CHECK_COUNT -lt $MAX_RETRIES ]; do',
      '  if sudo -u postgres pg_isready -U hapi -d hapi; then',
      '    echo "$(date): PostgreSQL health check PASSED" | tee -a /var/log/postgres-health.log',
      '    echo "PostgreSQL is ready and accepting connections" | tee -a /var/log/postgres-health.log',
      '    break',
      '  else',
      '    echo "$(date): PostgreSQL health check attempt $((HEALTH_CHECK_COUNT+1))/$MAX_RETRIES" | tee -a /var/log/postgres-health.log',
      '    HEALTH_CHECK_COUNT=$((HEALTH_CHECK_COUNT+1))',
      '    sleep 20',
      '  fi',
      'done',
      '',
      'if [ $HEALTH_CHECK_COUNT -eq $MAX_RETRIES ]; then',
      '  echo "$(date): PostgreSQL health check FAILED after $MAX_RETRIES attempts" | tee -a /var/log/postgres-health.log',
      '  exit 1',
      'fi',
      '',
      'echo "PostgreSQL setup completed successfully"',
    );

    // PostgreSQL EC2 Instance
    this.postgresInstance = new ec2.Instance(this, 'PostgresInstance', {
      instanceType: new ec2.InstanceType(POSTGRES_INSTANCE_TYPE),
      machineImage: ami,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: postgresSecurityGroup,
      role: postgresRole,
      userData: postgresUserData,
      keyPair: this.keyPair,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    cdk.Tags.of(this.postgresInstance).add('Name', postgresId);
    cdk.Tags.of(this.postgresInstance).add('Service', 'PostgreSQL');

    // HAPI FHIR User Data Script - Compressed with gzip+base64 to fit within 16KB limit
    const hapiScriptContent = `#!/bin/bash
set -euxo pipefail

# Logging setup
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
echo "Starting HAPI FHIR installation and configuration"

# Install CloudWatch Agent
echo "Installing CloudWatch Agent..."
dnf install -y amazon-cloudwatch-agent

# Create hapi user early (needed for log file permissions)
echo "Creating hapi user..."
useradd -r -s /bin/false hapi || true

# Create log files with proper permissions before starting service
echo "Creating log files..."
touch /var/log/hapi-fhir.log
touch /var/log/hapi-build.log
touch /var/log/hapi-health.log
touch /var/log/hapi-gc.log
chown hapi:hapi /var/log/hapi-fhir.log
chown hapi:hapi /var/log/hapi-build.log
chown hapi:hapi /var/log/hapi-health.log
chown hapi:hapi /var/log/hapi-gc.log
chmod 644 /var/log/hapi-fhir.log
chmod 644 /var/log/hapi-build.log
chmod 644 /var/log/hapi-health.log
chmod 644 /var/log/hapi-gc.log

# Configure CloudWatch Agent
# Get instance ID using IMDSv2 (required for Amazon Linux 2023)
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" -s)
INSTANCE_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/instance-id)
echo "Instance ID: $INSTANCE_ID"
cat > /opt/aws/amazon-cloudwatch-agent/etc/config.json <<EOFCW
{
  "agent": {
    "metrics_collection_interval": 60
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/user-data.log",
            "log_group_name": "/aws/ec2/${hapiId}",
            "log_stream_name": "user-data",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/hapi-build.log",
            "log_group_name": "/aws/ec2/${hapiId}",
            "log_stream_name": "maven-build",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/hapi-health.log",
            "log_group_name": "/aws/ec2/${hapiId}",
            "log_stream_name": "health-check",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/hapi-fhir.log",
            "log_group_name": "/aws/ec2/${hapiId}",
            "log_stream_name": "hapi-fhir-service",
            "timezone": "UTC"
          }
        ]
      }
    }
  },
  "metrics": {
    "namespace": "HapiLoadTest",
    "metrics_collected": {
      "cpu": {
        "measurement": [
          {"name": "cpu_usage_idle", "rename": "CPU_IDLE", "unit": "Percent"},
          {"name": "cpu_usage_active", "rename": "CPU_ACTIVE", "unit": "Percent"},
          {"name": "cpu_usage_iowait", "rename": "CPU_IOWAIT", "unit": "Percent"},
          {"name": "cpu_usage_system", "rename": "CPU_SYSTEM", "unit": "Percent"},
          {"name": "cpu_usage_user", "rename": "CPU_USER", "unit": "Percent"}
        ],
        "metrics_collection_interval": 60,
        "totalcpu": true
      },
      "disk": {
        "measurement": [
          {"name": "used_percent", "rename": "DISK_USED", "unit": "Percent"},
          {"name": "inodes_free", "rename": "DISK_INODES_FREE", "unit": "Count"}
        ],
        "metrics_collection_interval": 60,
        "resources": ["*"]
      },
      "diskio": {
        "measurement": [
          {"name": "io_time", "rename": "DISKIO_TIME", "unit": "Milliseconds"},
          {"name": "read_bytes", "rename": "DISKIO_READ_BYTES", "unit": "Bytes"},
          {"name": "write_bytes", "rename": "DISKIO_WRITE_BYTES", "unit": "Bytes"},
          {"name": "reads", "rename": "DISKIO_READS", "unit": "Count"},
          {"name": "writes", "rename": "DISKIO_WRITES", "unit": "Count"}
        ],
        "metrics_collection_interval": 60,
        "resources": ["*"]
      },
      "mem": {
        "measurement": [
          {"name": "mem_used_percent", "rename": "MEM_USED_PERCENT", "unit": "Percent"},
          {"name": "mem_available", "rename": "MEM_AVAILABLE", "unit": "Bytes"},
          {"name": "mem_used", "rename": "MEM_USED", "unit": "Bytes"},
          {"name": "mem_total", "rename": "MEM_TOTAL", "unit": "Bytes"}
        ],
        "metrics_collection_interval": 60
      },
      "netstat": {
        "measurement": ["tcp_established", "tcp_time_wait"],
        "metrics_collection_interval": 60
      },
      "net": {
        "measurement": [
          {"name": "bytes_sent", "rename": "NET_BYTES_SENT", "unit": "Bytes"},
          {"name": "bytes_recv", "rename": "NET_BYTES_RECEIVED", "unit": "Bytes"},
          {"name": "packets_sent", "rename": "NET_PACKETS_SENT", "unit": "Count"},
          {"name": "packets_recv", "rename": "NET_PACKETS_RECEIVED", "unit": "Count"}
        ],
        "metrics_collection_interval": 60,
        "resources": ["*"]
      }
    },
    "aggregation_dimensions": [["InstanceId"]],
    "append_dimensions": {
      "InstanceId": "\${INSTANCE_ID}",
      "InstanceType": "${HAPI_INSTANCE_TYPE}",
      "Service": "HAPI-FHIR"
    }
  }
}
EOFCW

# Start CloudWatch Agent
echo "Starting CloudWatch Agent..."
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json

# Discover PostgreSQL private IP using AWS CLI (filter by same VPC)
echo "Discovering PostgreSQL instance..."

# Get this instance's VPC ID from metadata service
INSTANCE_MAC=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/mac)
echo "Instance MAC address: $INSTANCE_MAC"

VPC_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -s http://169.254.169.254/latest/meta-data/network/interfaces/macs/$INSTANCE_MAC/vpc-id)
echo "This instance is in VPC: $VPC_ID"

POSTGRES_HOST=$(aws ec2 describe-instances --region ${this.region} --filters "Name=tag:Service,Values=PostgreSQL" "Name=vpc-id,Values=$VPC_ID" "Name=instance-state-name,Values=running" --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)
echo "Found PostgreSQL at: $POSTGRES_HOST"

# Wait for PostgreSQL to be reachable
echo "Waiting for PostgreSQL to be reachable..."
RETRY_COUNT=0
MAX_RETRIES=30
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if timeout 2 bash -c "</dev/tcp/$POSTGRES_HOST/5432"; then
    echo "PostgreSQL is reachable"
    break
  fi
  echo "Attempt $((RETRY_COUNT+1))/$MAX_RETRIES - PostgreSQL not ready yet, waiting..."
  RETRY_COUNT=$((RETRY_COUNT+1))
  sleep 10
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "ERROR: PostgreSQL not reachable after $MAX_RETRIES attempts"
  exit 1
fi

# PostgreSQL connection details
POSTGRES_PORT="5432"
POSTGRES_DB="hapi"
POSTGRES_USER="hapi"
POSTGRES_PASSWORD="hapi"

# Install Java 17 and download Maven 3.9+
echo "Installing Java 17..."
dnf install -y java-17-amazon-corretto-devel git wget tar

echo "Downloading and installing Maven 3.9.12..."
cd /tmp
wget https://downloads.apache.org/maven/maven-3/3.9.12/binaries/apache-maven-3.9.12-bin.tar.gz
tar xzf apache-maven-3.9.12-bin.tar.gz
mv apache-maven-3.9.12 /opt/maven
ln -s /opt/maven/bin/mvn /usr/local/bin/mvn
export PATH=/opt/maven/bin:$PATH
mvn --version

# Create hapi directory
echo "Creating hapi directory..."
mkdir -p /opt/hapi
cd /tmp

# Clone and build HAPI FHIR from master branch
echo "Cloning HAPI FHIR repository (master branch)..."
git clone --depth 1 https://github.com/hapifhir/hapi-fhir-jpaserver-starter.git
cd hapi-fhir-jpaserver-starter

echo "Building HAPI FHIR with Spring Boot profile (this will take 5-10 minutes)..."
echo "Maven build started at $(date)" | tee /var/log/hapi-build.log
mvn clean package spring-boot:repackage -DskipTests -Pboot 2>&1 | tee -a /var/log/hapi-build.log
echo "Maven build completed at $(date)" | tee -a /var/log/hapi-build.log

# Copy the built WAR (which is executable) to /opt/hapi
echo "Installing HAPI FHIR..."
cp target/ROOT.war /opt/hapi/hapi-fhir-jpaserver.jar
chown -R hapi:hapi /opt/hapi

# Cleanup build directory
cd /
rm -rf /tmp/hapi-fhir-jpaserver-starter

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/hapi-fhir.service <<EOF
[Unit]
Description=HAPI FHIR Server
After=network.target

[Service]
Type=simple
User=hapi
WorkingDirectory=/opt/hapi

# Database
Environment="SPRING_DATASOURCE_URL=jdbc:postgresql://\${POSTGRES_HOST}:\${POSTGRES_PORT}/\${POSTGRES_DB}"
Environment="SPRING_DATASOURCE_USERNAME=\${POSTGRES_USER}"
Environment="SPRING_DATASOURCE_PASSWORD=\${POSTGRES_PASSWORD}"
Environment="SPRING_DATASOURCE_DRIVER_CLASS_NAME=org.postgresql.Driver"

# OpenTelemetry Configuration (environment variables for standard OTEL agent)
Environment="OTEL_SERVICE_NAME=hapi-fhir"
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

ExecStart=/usr/bin/java \\\\
    -javaagent:/opt/hapi/opentelemetry-javaagent.jar \\\\
    -Xms4096m \\\\
    -XX:MaxRAMPercentage=85.0 \\\\
    -Xlog:gc*:file=/var/log/hapi-gc.log:time,uptime:filecount=5,filesize=100m \\\\
    -Dspring.jpa.properties.hibernate.dialect=ca.uhn.fhir.jpa.model.dialect.HapiFhirPostgresDialect \\\\
    -Dhapi.fhir.server_address=http://0.0.0.0:8080/fhir \\\\
    -Dhapi.fhir.pretty_print=false \\\\
    -Dserver.tomcat.threads.max=200 \\\\
    -Dserver.tomcat.threads.min-spare=50 \\\\
    -Dserver.tomcat.accept-count=500 \\\\
    -Dserver.tomcat.max-connections=8192 \\\\
    -Dserver.tomcat.mbeanregistry.enabled=true \\\\
    -Dspring.datasource.hikari.maximum-pool-size=10 \\\\
    -Dspring.datasource.hikari.minimum-idle=5 \\\\
    -Dspring.jpa.properties.hibernate.jdbc.batch_size=50 \\\\
    -Dspring.jpa.properties.hibernate.order_inserts=true \\\\
    -Dspring.jpa.properties.hibernate.order_updates=true \\\\
    -Dspring.jpa.properties.hibernate.jdbc.batch_versioned_data=true \\\\
    -Dlogging.level.ca.uhn.fhir=WARN \\\\
    -Dlogging.level.org.hibernate.SQL=WARN \\\\
    -Dlogging.level.org.springframework=WARN \\\\
    -jar /opt/hapi/hapi-fhir-jpaserver.jar

Restart=always
RestartSec=10
StandardOutput=append:/var/log/hapi-fhir.log
StandardError=append:/var/log/hapi-fhir.log
SyslogIdentifier=hapi-fhir

[Install]
WantedBy=multi-user.target
EOF

# Enable and start HAPI FHIR service
echo "Enabling HAPI FHIR service..."
systemctl daemon-reload
systemctl enable hapi-fhir
echo "Starting HAPI FHIR service..."
systemctl start hapi-fhir

sleep 5
if systemctl is-active --quiet hapi-fhir; then
  echo "HAPI FHIR service started successfully"
else
  echo "ERROR: HAPI FHIR service failed to start"
  systemctl status hapi-fhir
  journalctl -u hapi-fhir -n 50 --no-pager
  exit 1
fi

# Health check loop
echo "Starting health check loop..." | tee -a /var/log/hapi-health.log
HEALTH_CHECK_COUNT=0
MAX_RETRIES=20
echo "Waiting for HAPI FHIR to start (this may take up to 10 minutes for first boot)..." | tee -a /var/log/hapi-health.log

while [ $HEALTH_CHECK_COUNT -lt $MAX_RETRIES ]; do
  if curl -f -s http://localhost:8080/fhir/metadata > /dev/null 2>&1; then
    echo "$(date): HAPI FHIR health check PASSED" | tee -a /var/log/hapi-health.log
    echo "HAPI FHIR is ready and accepting connections" | tee -a /var/log/hapi-health.log
    curl -s http://localhost:8080/fhir/metadata | head -n 5 | tee -a /var/log/hapi-health.log
    break
  else
    echo "$(date): HAPI FHIR health check attempt $((HEALTH_CHECK_COUNT+1))/$MAX_RETRIES (waiting 30s...)" | tee -a /var/log/hapi-health.log
    HEALTH_CHECK_COUNT=$((HEALTH_CHECK_COUNT+1))
    sleep 30
  fi
done

if [ $HEALTH_CHECK_COUNT -eq $MAX_RETRIES ]; then
  echo "$(date): HAPI FHIR health check FAILED after $MAX_RETRIES attempts" | tee -a /var/log/hapi-health.log
  echo "Checking HAPI FHIR service status:" | tee -a /var/log/hapi-health.log
  systemctl status hapi-fhir | tee -a /var/log/hapi-health.log
  echo "Last 50 lines of HAPI FHIR logs:" | tee -a /var/log/hapi-health.log
  journalctl -u hapi-fhir -n 50 --no-pager | tee -a /var/log/hapi-health.log
  exit 1
fi

echo "HAPI FHIR setup completed successfully"
`;

    // Compress and base64 encode the script
    const compressedScript = zlib.gzipSync(Buffer.from(hapiScriptContent)).toString('base64');

    // Create minimal bootstrap user data that decompresses and runs the script
    const hapiUserData = ec2.UserData.forLinux();
    hapiUserData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      `echo "${compressedScript}" | base64 -d | gunzip > /tmp/hapi-setup.sh`,
      'chmod +x /tmp/hapi-setup.sh',
      '/tmp/hapi-setup.sh',
    );

    // HAPI FHIR EC2 Instance
    this.hapiInstance = new ec2.Instance(this, 'HapiInstance', {
      instanceType: new ec2.InstanceType(HAPI_INSTANCE_TYPE),
      machineImage: ami,
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: hapiSecurityGroup,
      role: hapiRole,
      userData: hapiUserData,
      keyPair: this.keyPair,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(500, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    cdk.Tags.of(this.hapiInstance).add('Name', `hapi-${HAPI_INSTANCE_TYPE}`);
    cdk.Tags.of(this.hapiInstance).add('Service', 'HAPI-FHIR');

    // Stack Outputs
    new cdk.CfnOutput(this, 'PostgresInstanceId', {
      value: this.postgresInstance.instanceId,
      description: 'PostgreSQL EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'HapiInstanceId', {
      value: this.hapiInstance.instanceId,
      description: 'HAPI FHIR EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'PostgresPrivateIP', {
      value: this.postgresInstance.instancePrivateIp,
      description: 'PostgreSQL private IP address',
    });

    new cdk.CfnOutput(this, 'HapiPrivateIP', {
      value: this.hapiInstance.instancePrivateIp,
      description: 'HAPI FHIR private IP address',
    });

    new cdk.CfnOutput(this, 'HapiPublicIP', {
      value: this.hapiInstance.instancePublicIp,
      description: 'HAPI FHIR public IP address',
    });

    new cdk.CfnOutput(this, 'HapiFhirEndpoint', {
      value: `http://${this.hapiInstance.instancePublicIp}:8080/fhir`,
      description: 'HAPI FHIR endpoint URL (accessible from within VPC)',
    });

    new cdk.CfnOutput(this, 'HapiFhirMetadataEndpoint', {
      value: `http://${this.hapiInstance.instancePublicIp}:8080/fhir/metadata`,
      description: 'HAPI FHIR metadata endpoint (health check, accessible from within VPC)',
    });

    new cdk.CfnOutput(this, 'TargetHost', {
      value: `http://${this.hapiInstance.instancePublicIp}:8080/fhir`,
      description: 'HAPI FHIR target host URL for load testing (public)',
    });

    new cdk.CfnOutput(this, 'HapiSSMCommand', {
      value: `aws ssm start-session --target ${this.hapiInstance.instanceId}`,
      description: 'AWS Systems Manager command to connect to HAPI instance',
    });

    new cdk.CfnOutput(this, 'SSHKeyPairId', {
      value: this.keyPair.keyPairId,
      description: 'SSH Key Pair ID',
    });

    new cdk.CfnOutput(this, 'PostgresLogGroupOutput', {
      value: postgresLogGroup.logGroupName,
      description: `PostgreSQL CloudWatch Logs: https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/${encodeURIComponent(postgresLogGroup.logGroupName)}`,
    });

    new cdk.CfnOutput(this, 'HapiLogGroupOutput', {
      value: hapiLogGroup.logGroupName,
      description: `HAPI FHIR CloudWatch Logs: https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:log-groups/log-group/${encodeURIComponent(hapiLogGroup.logGroupName)}`,
    });

    new cdk.CfnOutput(this, 'KeyPairName', {
      value: this.keyPair.keyPairName,
      description: 'Key pair name (download from EC2 console or use AWS CLI)',
    });
  }
}
