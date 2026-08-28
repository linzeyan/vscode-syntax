package com.example.poly

import scala.concurrent.{ExecutionContext, Future}
import scala.util.matching.Regex

/** A published release and its assets. */
final case class Release(tag: String, assets: List[String] = Nil):
  def version: (Int, Int, Int) = tag match
    case Release.Semver(major, minor, patch, _) => (major.toInt, minor.toInt, patch.toInt)
    case other => throw new IllegalArgumentException(s"bad tag: $other")

  override def toString: String = s"$tag (${assets.size} assets)"

object Release:
  private val Semver: Regex = raw"v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?".r

  def latest(releases: Seq[Release]): Option[Release] =
    releases.sortBy(_.version).lastOption

enum Level:
  case Debug, Info, Error

trait Verifier[A]:
  def verify(value: A): Either[String, A]

given Verifier[Release] with
  def verify(r: Release): Either[String, Release] =
    if r.assets.sizeIs >= 16 then Right(r) else Left(s"${r.tag}: only ${r.assets.size} assets")

def verifyAll(rs: List[Release])(using v: Verifier[Release], ec: ExecutionContext): Future[List[String]] =
  Future.sequence(rs.map(r => Future(v.verify(r)))).map(_.collect { case Left(err) => err })
