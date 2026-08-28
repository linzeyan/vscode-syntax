resource "aws_instance" "web" {
  ami           = var.ami_id
  instance_type = "t3.micro"

  tags = {
    Name = "web-${count.index}"
  }
}

variable "ami_id" {
  type        = string
  description = "AMI for the web instance"
}
