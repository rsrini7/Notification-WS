#!/bin/bash

# Backend Startup Script
# This script starts the backend components of the notification system:
# - Docker services (Kafka, Zookeeper, MailCrab)
# - Backend Spring Boot application

echo "===== Starting Backend Services ====="

# Function to check if a process is running on a specific port
check_port() {
  lsof -i:$1 > /dev/null 2>&1
  return $?
}

# 1. Start Docker Compose services
echo "Starting Docker Compose services..."
docker-compose up -d
if [ $? -ne 0 ]; then
  echo "Failed to start Docker Compose services. Exiting."
  exit 1
fi

# 2. Check and create Kafka topics if needed
echo "Checking Kafka topics..."
KAFKA_CONTAINER_NAME="notification-ws-kafka-1"
BROKER_LIST="kafka:9093"

# Wait for Kafka to be ready
echo "Waiting for Kafka to be ready..."
MAX_KAFKA_RETRIES=30
KAFKA_RETRY_COUNT=0
while ! docker exec $KAFKA_CONTAINER_NAME kafka-topics.sh --bootstrap-server $BROKER_LIST --list > /dev/null 2>&1; do
  if [ $KAFKA_RETRY_COUNT -ge $MAX_KAFKA_RETRIES ]; then
    echo "Kafka failed to start within the expected time. Exiting."
    exit 1
  fi
  echo -n "."
  sleep 2
  KAFKA_RETRY_COUNT=$((KAFKA_RETRY_COUNT+1))
done
echo ""
echo "Kafka is up and running!"

# Get list of existing topics
EXISTING_TOPICS=$(docker exec $KAFKA_CONTAINER_NAME kafka-topics.sh --bootstrap-server $BROKER_LIST --list)

# Check if all required topics exist
REQUIRED_TOPICS=("notifications" "critical-notifications" "broadcast-notifications")
TOPICS_MISSING=false

for TOPIC in "${REQUIRED_TOPICS[@]}"; do
  if ! echo "$EXISTING_TOPICS" | grep -q "^$TOPIC$"; then
    TOPICS_MISSING=true
    break
  fi
done

# Create topics only if some are missing
if [ "$TOPICS_MISSING" = true ]; then
  echo "Some Kafka topics are missing. Creating topics..."
  ./create-kafka-topics.sh
  if [ $? -ne 0 ]; then
    echo "Failed to create Kafka topics. Exiting."
    exit 1
  fi
else
  echo "All required Kafka topics already exist. Skipping topic creation."
fi

# Verify Kafka connectivity from host machine
echo "Verifying Kafka connectivity from host machine..."
MAX_CONNECT_RETRIES=10
CONNECT_RETRY_COUNT=0
while ! nc -z localhost 9092; do
  if [ $CONNECT_RETRY_COUNT -ge $MAX_CONNECT_RETRIES ]; then
    echo "Cannot connect to Kafka on localhost:9092. Exiting."
    exit 1
  fi
  echo -n "."
  sleep 2
  CONNECT_RETRY_COUNT=$((CONNECT_RETRY_COUNT+1))
done
echo ""
echo "Kafka is accessible from host machine!"

# 3. Start Backend
echo "Starting Backend service..."
cd backend
./mvnw spring-boot:run &
BACKEND_PID=$!
cd ..
echo "Backend started with PID: $BACKEND_PID"

# Wait for backend to be ready
echo "Waiting for backend to start..."
MAX_RETRIES=30
RETRY_COUNT=0
while ! check_port 8080; do
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "Backend failed to start within the expected time."
    break
  fi
  echo -n "."
  sleep 2
  RETRY_COUNT=$((RETRY_COUNT+1))
done
echo ""

# Save PID to file
echo "$BACKEND_PID" > .backend_pid

echo "===== Backend Services Started ====="
echo "Backend:  http://localhost:8080"
echo "MailCrab: http://localhost:1080"